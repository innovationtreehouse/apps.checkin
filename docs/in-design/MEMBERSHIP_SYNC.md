# Membership Sync — Google Groups (email) + Slack channels

**Status:** Design v3, for review. No code. Development is gated on the #1248 program rollover design (§2.6). Supersedes PRs #1156 and #1157 (both closed in favour of this doc).
**Date:** 2026-11-20
**Purpose:** Keep Google Group membership (program groups, the members list, the newsletter) and Slack channel membership in step with who is actually enrolled and current — while treating a person's decision to join or leave a list as a first-class, auditable intent that the sync must never silently override.

This doc is written so an implementation session can pick it up cold. Read §1 for what is true today, §2 for the model, §3 for the intent/consent core, §10 for what is deliberately unanswered, then §11 for the PR sequence.

**Changes from v2 (re-checked against `main` and owner decisions, 2026-11-19/20):**

- Intent is keyed by **list address or channel id**, not program id; the ledger key drops `scope` (§2.2, §10.1).
- Yearly "you're off this list" notice plus a **Board action** that records an IN or OUT the person asked for (§3.2, §10.1).
- The members list follows `OrgMembership.status` alone; lapse is the Board's revoke (§2.1).
- Newsletter removal: **DENIED or household archive**; a restore does not re-add (§2.1, §2.3).
- Runs, carry-over and `RESERVED` places come from the #1248 rollover design; team lists count carried-over people in any state and new people once `ACTIVE`, and an **ongoing** run keeps its people through the gap until the next run starts (§2.3, §2.6).
- A **person merge is refused** while the two records' list choices differ (§4.1).
- Google credentials follow the Gmail receipt refresh-token pattern (§1).
- The sync lives in the host (`lib/sync/`); the Google and Slack clients are two database-less packages (§1, §10.6).
- Corrected against `main`: the status choke point is `setHouseholdStatus`, archived households are excluded with `IN_LIVE_HOUSEHOLD`, emails compare through `canonicalizeEmail`, outbound calls need registry and egress-allowlist entries, and the ledger is `ListSyncState` because `SyncState` is taken (§1, §8, §11).

---

## 1. Current state

**Nothing ships today.** There is no Google Groups or Slack integration in `main`. Two PRs carried an earlier version of this feature and are now closed:

- **#1156** — schema, Google/Slack clients, desired-state engine. Inert; nothing called it.
- **#1157** — one line in `src/security/scopeBindings.ts` queueing `ProgramSlackAuth`, split out under the boundary-isolation rule.

Their engine design is carried forward here largely unchanged (§2). What changed is the intent/consent layer (§3–§5).

Existing machinery this design reuses:

- `AuditLog` (`actorId`, `action`, `tableName`, `affectedEntityId`, `secondaryAffectedEntity`, `oldData`, `newData`). A change to a `Person` column is filed under `Person`, not under whatever table the *route* is about.
- `Person.emailUndeliverableAt` — the bounce stamp maintained by the Resend webhook, cleared on a later delivery; consulted by the classification guards (§3.3).
- `setHouseholdStatus` (`lib/membership/householdStatus.ts`) — the one writer of `OrgMembership.status`; the activation, DENIED and restore triggers hook it (§8).
- `lib/household/archiveAction.ts` and `IN_LIVE_HOUSEHOLD` (`lib/household/archived.ts`) — household archive. Row security hides an archived household, not its people, so every person query in `computeDesiredState` filters with `IN_LIVE_HOUSEHOLD`.
- `canonicalizeEmail` (`lib/emailNormalize.ts`) — strips `+tags` and Gmail dots; the email-level diff compares canonical forms (§2.2).
- `lib/person/merge/` — the merge guard and executor; the sync tables join the relations it moves (§4.1).
- `lib/programAnnounce.ts` — the shape for this design's immediate triggers (§8).
- The lifecycle drift panel (`LifecycleDriftPanel`, `lib/lifecycleDrift.ts`) — the pattern for the sync's invariant oracle (§8.1).

To be built (none exists in `main`):

- `BoardSettings.membersGoogleGroupEmail` / `.newsletterGoogleGroupEmail` — the two org-wide list addresses. Both are Google Groups in the org's own Workspace domain [Decision — owner, 2026-11-19], managed through the same account as the program lists.
- `config.googleDirectoryConfigured()` — integration is OFF unless the Google refresh token is present. Same null ⇒ off pattern as Resend and the s-read mirror.
- **Google credentials follow the Gmail receipt pattern [Decision — owner, 2026-11-19]:** a dedicated Workspace account holding an admin role limited to Groups consents once through a consent tool that refuses every scope but group membership and read-only audit reports; a refresher keeps the token fresh, as `gmail-refresher-function` does for receipt mail. No service account and no domain-wide delegation.
- **Where the code lives [Decision — owner, 2026-11-20]:** the sync is host code under `checkin-app/src/lib/sync/` behind a narrow interface. Two client packages hold only the external APIs, with no database and no list rules, the way `@checkin/quickbooks` does: `@checkin/google-workspace` (Directory group members and Reports, one credential) and `@checkin/slack` (channel members, per-program bot key). See §10.6.

## 2. Core model (engine carried forward from #1156)

### 2.1 Desired state is a pure function

`computeDesiredState(now)` reads live rosters and memberships and emits the complete "who should be in what" set on every run. It is **not** event-driven and keeps no bookkeeping of its own.

Everything awkward falls out of a plain diff against observed reality: program-boundary removal, revoke, and the youth reason-union need no special-case code. A desired entry is `(personId, targetKind, targetRef)` with the reasons that make it desired:

| targetKind | targetRef | reason scope | removal |
|---|---|---|---|
| `google_group` | program team-list email | `program:<id>` | when no longer desired (§2.6 for ongoing programs), at next reconcile or immediate trigger |
| `google_group` | members list email | `org` | when no longer desired, at next reconcile or immediate trigger |
| `newsletter` | newsletter email | `org` | the person's own OUT (§3.2) always removes; otherwise **only DENIED or household archive** — never revoke or any other status change; a restore does not re-add (§2.3) |
| `slack_channel` | channel id | `program:<id>` | when no longer desired, with an audit entry and no grace period (§3.6) |

Nothing runs between triggers: removal happens at the next nightly reconcile, or sooner when an immediate trigger fires (§8).

**Lapse is the Board's revoke [Decision — owner, 2026-11-19]:** the members list follows `OrgMembership.status` alone. A household past its valid-through day (`isMembershipLapsed`) stays ACTIVE, and stays on the list, until the Board revokes it; the Board cleans up households that do not renew. If a GRACE/INACTIVE layer (backlog M1) ever lands, its statuses become inputs to `computeDesiredState` with no engine change.

### 2.2 `ListSyncState` is a cache, not a source of truth

One row per `(personId, targetKind, targetRef)`. The list address or channel id is the list's identity: a team that reuses its address year over year is the same list, and a new address is a new list (§10.1). The scopes that make the person desired go in `reasons`, not in the key. The row records what was *applied* externally — **including the address it was applied under** (`appliedEmail`) — the last error, retry state, provenance, and the person's last expressed intent (§3.2). Desired state is always recomputed live; the ledger never decides who belongs.

(`SyncState` is already a model in `packages/s-ingest-core`, hence the name.)

**The reconcile diff runs at the email level**, not the person level: per target, the desired set (each desired person's *current* email) is compared against the observed member set (`listMembers` / `conversations.members`) and the ledger's applied emails, all through `canonicalizeEmail`, so one address written two ways never reads as a removal plus a ghost. §4 explains why person-level diffing is wrong.

### 2.3 Population rules (per target)

Every person query filters with `IN_LIVE_HOUSEHOLD`, so an archived household's people are desired nowhere.

- **Program team list:** every household lead of **any enrolled minor** (regardless of the minor's age), plus enrolled persons **13+** themselves, plus the program's leader and core volunteers (`ProgramVolunteer.isCore`). A household with only an 8-year-old enrolled is on the list via its leads — the younger the child, the more the parent needs the list.

  **Who counts as enrolled [Decision — owner, 2026-11-20; #1248 Q29]:** someone carried over from the previous run counts in any state (`RESERVED`, any `PENDING_*`, `ACTIVE`); someone new to the chain counts only once their place is `ACTIVE` (paid, comped or free). A declined or released reservation stops counting. `WITHDRAWN` and removed enrollments never count. When an ended run's people come off is §2.6.
- **Members list:** baseline = the household leads of every ACTIVE household — minimum one per household (§3.5 covers opt-outs dropping a household below that). Others — including 13+ youth — may join at their own discretion; there are no secrets on the members list. Discretionary joins arrive by hand (Google-side) or by in-app opt-in and are respected per §3.2/§5.
- **Newsletter:** default = one household lead per family, opted in on activation (per CM10); anyone else opts in freely. The default records an IN (`DEFAULT`) the first time it applies, so it never re-applies. DENIED or household archive records an OUT (`BOARD`, the acting Board member as actor) on every newsletter row of that household, so a later restore (DENIED → NONE, or un-archive) re-adds no one; the person opts in again from the app [Decision — owner, 2026-11-19].
- **Under-13:** no one under 13 is on any app-managed list or channel, by any path: the sync never adds them, and an in-app opt-in is refused. Their household leads are on the program list in their place.

### 2.4 Scope: the team list only, for now

This design models **one** Google group per program — the team list. The fuller CM6 shape (up to three lists per team: team / parents-only / mentors-only) exists today outside checkin's control and is **deliberately deferred**. The model extends to it without engine change (more `targetRef`s per program, role-filtered population rules).

The team-list address is a **field on `Program`**. Today each year's program row repeats the address; after the program→instance restructure it sits on the year-less definition. Because the ledger keys on the address, either shape works and only `computeDesiredState` changes. Slack configuration is its own table attached to `Program` (§6); a program "uses Slack" by having a row.

### 2.5 `ProgramSlackAuth`

Per-program Slack bot tokens live in their own table, never as a column on `Program` — otherwise every `program.findMany()` without an explicit `select` risks pulling a secret into memory.

**Provisioning.** People set up each program's Slack workspace and bot by hand, outside the app. An administrator then pastes the bot key into a settings screen, which writes the `ProgramSlackAuth` row. The screen shows whether a key is set and when, never the key itself, and every save writes an audit entry.

**IT Stewards.** A new role (`PersonRoleKind.IT_STEWARD`, granted through `PersonRole`) may edit integration settings, this bot key among them, and nothing else: it grants no access to people, households, money or any other settings. Sysadmins keep the access they have. The role is a boundary change and ships in its own PR, ahead of the settings screen (§11).

### 2.6 Runs, carry-over and ongoing programs (#1248)

**Runs and carry-over are the #1248 design's** (`PROGRAM_ROLLOVER.md`); this section states only what the sync reads from it and decides on top of it [Decision — owner, 2026-11-20].

What the sync reads from #1248:

- **A chain of runs.** Each run is its own `Program` row; `Program.previousRunId` links it to the run it follows, segments and years alike: Fall Training 2026 → Competition 2026 → Championships 2026 → Summer 2026 → Fall Training 2027. Every link is a carry-over point.
- **Carry-over.** The leader or a program administrator carries over the immediately previous run's roster, unticking graduates. Each ticked person gets a `RESERVED` place that holds a seat and owes nothing; the family confirms (→ `PENDING_*`, or `ACTIVE` on a free run) or declines (row removed) by the run's confirmation deadline, and the nightly sweep releases unconfirmed reservations at the deadline. "Carried over" is derived: the person was on the previous run's roster.
- **The ongoing checkbox.** A run (its `Program` row) is marked **ongoing** when a next run is expected. Links alone cannot tell "finished for good" from "next run not created yet"; the checkbox records that intent. #1248 also uses it for a Board reminder when an ongoing run has ended with no next run.

What the sync decides on top:

- **A run's people stay desired while it runs.** Anyone counted on a run (§2.3) is desired from the day they count until the run ends.
- **An ended ongoing run keeps its people until its next run starts.** Through the gap (Summer ends Aug 31; Fall Training starts Sept 8), no one comes off and no one is re-added, so Google sends no add/remove churn.
- **At the next run's start, the next run's roster takes over.** Carried-over people stay (they count in any state on the new run); graduates and anyone who declined or was released come off at the next reconcile or trigger.
- **A decline or release takes effect at the hand-over, not the day it happens [Decision — owner, 2026-11-20].** A family that declines Fall Training 2027 in July while still `ACTIVE` on Summer 2026 stays on the list through Summer, and comes off when Summer ends (or, if Summer is ongoing, when Fall Training starts). It no longer counts on the next run; it still counts on the run it is on.
- **A missed carry-over removes no one.** If the next run starts with no carry-over done (no reservations from the previous roster), the ended run's people stay; the leader gets a `CARRY_OVER_MISSED` follow-up.
- **A run not marked ongoing** comes off the list when it ends.

**Dependency — development is gated on #1248.** `previousRunId`, `RESERVED`, the carry-over screen and the ongoing checkbox are #1248's. No PR in §11 starts until it ships.

## 3. Intent, consent, and audit

The engine above is add/remove symmetric and has no opinion about *who* did the removing. This section is that opinion.

### 3.1 Every add is audited

Adding a person to a list is a real-world act — their address starts receiving mail. Each successful add writes an `AuditLog` row: actor (the sync's system actor), the target, and the reasons that made it desired.

**Exception: newsletter adds are not audited.** Add-only in practice, low-stakes, and would be the highest-volume audit source in the app for no investigative value. Newsletter *intent* is still recorded in the ledger — an unsubscribe must stick — it just raises no audit rows or follow-ups.

### 3.2 Membership intent is first-class and bi-directional

A person's presence on a list reflects their **last expressed intent**, from either side, in either order:

- **OUT intent:** in-app opt-out, an observed external removal (unsubscribe/leave) that passes the §3.3 guards, or a Board member recording an OUT the person asked for.
- **IN intent:** in-app opt-in, an observed external (re-)join — someone re-added by hand on the Google side, or rejoining a Slack channel — or a Board member recording that the person asked to be re-added. The sync adopts it and leaves them alone.

**The invariant:** no *system* code path may override the last intent. An OUT is never undone by a reconcile, a retry, a row rebuild, or an admin resetting sync state — only a **new, authenticated, audited IN intent** clears it: the person in-app, their own external re-join, or a Board member recording the person's own request (team and members lists only, with a required note; §10.1). A Board member may likewise record an OUT the person asked for, on any list, including to settle a merge (§4.1). An in-app toggle *is* new intent, not a system override, and the Board action records the person's request under a named actor.

The newsletter's DENIED/archive OUT (§2.3) is the one OUT recorded without the person asking; it carries the Board actor who denied or archived, and only the person's own opt-in clears it.

Ledger fields: `lastIntent` (`IN` | `OUT`), `lastIntentAt`, `lastIntentSource` (`APP` | `EXTERNAL` | `BOARD` | `DEFAULT`), `lastIntentActorId`, and `lastNoticeYear` (§10.1). While `lastIntent = OUT`, desired-state adds for that row are suppressed.

**Ordering external vs in-app intents.** Primary: if the Google Workspace **Reports API** (§10.4) yields a timestamped event for the external change, last-intent-wins is a straight timestamp comparison. Fallback — when the event isn't available (Reports retrieval lag has no SLA; Slack's audit API is Enterprise Grid-only, so Slack never has one; lookup failure): the removal is only known to have happened "sometime since the last reconcile." In that ambiguity, **the removal wins**: re-adding on the strength of an in-app opt-in that *might* predate the unsubscribe risks mailing someone after they asked out. A new in-app opt-in *after* the observation is unambiguously later and wins normally. Worst case costs one extra opt-in click; the compliance risk runs the other way.

When an in-window opt-in is overridden this way, the person's comm-settings toggle (`/communication`) must not silently revert: the UI shows why — "your opt-in was superseded by an unsubscribe; opt in again to rejoin."

### 3.3 Classification guards — before an external absence counts as OUT

An applied row whose email is absent from the external member list is **not automatically a choice**. In order:

1. **Bounce-eject.** If the person's `emailUndeliverableAt` is set, the absence is (or plausibly is) Google's automatic removal of a bouncing address — a delivery failure, not intent. No OUT; raise a `DELIVERY_EJECT` follow-up (§3.4) so a human fixes the address; the person is re-added once the stamp clears.
2. **Email change in flight.** If the person's canonical checkin email differs from the row's `appliedEmail`, this is a propagation event (§4), not a removal. No OUT.
3. **Actor attribution.** The Groups API cannot distinguish self-removal from an admin removing them by hand. **Open (§10.4).** Until resolved, the recorded event and audit language say **"external removal"** — never "self-removal".

Only an absence that survives all three guards records `lastIntent = OUT` (`EXTERNAL`), writes an `AuditLog` row, and raises a follow-up.

### 3.4 Every removal raises a follow-up, routed by audience

Any OUT intent raises a `SyncFollowUp` (§6), routed to whoever should care:

| target | audience |
|---|---|
| members list | Board |
| program team list | that program's leader |
| newsletter | **nobody** — expected churn, no-op |

A member leaving the members list usually means something — a lapsed member, a disputed renewal, quiet disengagement. A person leaving a program list is something that program's leader needs to know.

### 3.5 Household coverage loss — notify, don't re-add

If OUT intents leave an ACTIVE household with **no lead on the members list**, the sync does **not** auto re-add anyone (CM2's "Rule A" is rejected for now). It raises a `COVERAGE_DROP` follow-up → notification + Board dashboard entry.

This is a customer-service problem until proven otherwise: learn how often it happens and *why people leave* before building automation.

### 3.6 Slack, by symmetry

The same intent model applies to Slack: `conversations.members` gives the same observation capability `listMembers` does, detection and guards are symmetric, and an OUT suppresses re-invites identically. Hard (non-expiring) suppression is acceptable **because** the re-add paths exist — rejoin the channel, or in-app opt-in — and the follow-up screens make the event visible.

Removal from a Slack channel is immediate: when a person stops being desired, the next reconcile or immediate trigger removes them and writes an audit entry. No warning and no grace period, because re-adding is easy and the audit entry records what happened.

## 4. Email change and the swap case

When a person's checkin email changes, every checkin-managed list and channel must be **actively** updated — an immediate trigger on the change *plus* the nightly reconcile as backstop — until the old address is fully cleaned out.

This is why the diff runs at the **email level** (§2.2). The hard case, which really occurs: household leads A and B, where A's address changes to `C@` and B's address changes to A's *old* address (some couples deliberately share one address). Per target:

- desired emails: `{C@, A_old}` (A's new, B's new)
- observed: `{A_old, B_old}`
- diff: **add `C@`, remove `B_old`** — `A_old` never leaves the group; the ledger rebinds which person's row it is applied under.

Person-level diffing would misfire here (remove-then-re-add races, or classifying A's "absence" as an OUT). Email-level diffing plus guard §3.3-2 makes the swap boring. The engine sequences adds before removes within a target so shared addresses never drop off transiently.

### 4.1 Person merge

The sync tables are host tables, so the merge executor (`lib/person/merge/execute.ts`) moves the merged person's ledger rows and follow-ups to the keeper inside the merge transaction, and `mergeRepointDriftGuard.test.ts` holds it to that like every other Person foreign key. Open follow-ups that collide collapse to one per `(kind, personId, targetRef)`.

**A merge is refused while the two people's list choices differ [Decision — owner, 2026-11-19].** If both have a row for the same list and one is OUT while the other is IN or applied, the merge guard (`lib/person/merge/guard.ts`) refuses it, under the merge's locks, and names the lists. No rule picks a winner, because no assumption is safe. The Board asks the person what they want and records it on one of the two records with the Board action of §3.2 (IN or OUT, with a required note); the merge then goes through. Where only one of the two has a row for a list, the row moves to the keeper unchanged.

## 5. Ghost detection — observed, surfaced, never auto-removed

The sync **never removes anyone it did not add**. It *detects* them: an address present externally that is neither desired nor in the ledger (and not an adopted discretionary join of a known person, §3.2) is a **ghost** — possibly innocent (a hand-added collaborator), possibly a problem (an expired member nobody removed, an unknown address).

- Ghosts appear on a review screen per target, routed like §3.4 (program list → leader; members list/newsletter → Board).
- Removal from that screen is a deliberate admin action, audited, done via **checkbox selection** (including select-all in the header) — there is no "remove all ghosts" one-shot.
- Known-person external joins are not ghosts; they're IN intents (§3.2) and get adopted.

## 6. Data model changes

New table **`ListSyncState`**, one row per `(personId, targetKind, targetRef)`:

| field | purpose |
|---|---|
| `appliedEmail` | the canonical address the external add was applied under; drives email-level diffing (§2.2, §4) |
| `reasons` | the scopes that made the person desired at the last apply |
| `lastIntent` | `IN` \| `OUT` — last expressed intent (§3.2); `OUT` suppresses adds |
| `lastIntentAt` | when; used by the §3.2 tie-break |
| `lastIntentSource` | `APP` \| `EXTERNAL` \| `BOARD` \| `DEFAULT` |
| `lastIntentActorId` | the Board member for `BOARD`; null otherwise |
| `lastNoticeYear` | membership year of the last yearly notice (§10.1) |
| error / retry fields | last error and retry state |

New table **`SyncFollowUp`** — modeled on `PaymentException`'s shape (kind/status/resolution) with its own key and surfaces. Reusing existing queues was rejected: `PaymentException` is the wrong domain (sync items would live under Finance Ops); `IntegrationErrorLog` is wrong twice over — a removal is not an *error*, and the audiences differ per target.

| field | notes |
|---|---|
| `kind` | `EXTERNAL_REMOVAL` · `COVERAGE_DROP` · `DELIVERY_EJECT` · `CARRY_OVER_MISSED` |
| `audience` | `BOARD` · `PROGRAM_LEAD` — drives which surface shows it |
| `personId` (null for `CARRY_OVER_MISSED`), `targetKind`, `targetRef` | what happened where |
| `status` | `OPEN` · `ACKNOWLEDGED` · `RESOLVED` |
| `resolvedById`, `resolvedAt`, `resolutionNote` | resolve-with-note, like PaymentException |

Uniqueness: one non-`RESOLVED` row per `(kind, personId, targetRef)` — nightly re-detection is idempotent; a recurrence after resolution opens a fresh row.

Slack: a per-program config table (channel id + reference to `ProgramSlackAuth`), attached to `Program`; presence of a row = the program uses Slack. `Program` gains the team-list group email field (§2.4). `PersonRoleKind` gains `IT_STEWARD` (§2.5).

No change to `AuditLog`. Entries are filed under `tableName: "ListSyncState"`, with `affectedEntityId` = the ledger row, `secondaryAffectedEntity` = the person, and the target in `newData`.

## 7. Adoption and initial rollout

### 7.1 The adopt rule

On reconcile: **desired + present externally + no ledger row ⇒ adopt** — write the ledger row as applied (with the observed email), no insert call, no audit row. This is how the first reconcile inherits today's hand-maintained groups without a wall of spurious "adds," and how a hand re-add on the Google side is honoured (§3.2).

### 7.2 Initial bulk enrollment

The first live run is its own problem: Google sends group-subscription notification emails, the Directory API has write quotas, and it would be the highest-volume audit day ever. Plan:

1. **Dry-run report first**, per target: who would be adopted, who would be newly added, who looks like a ghost. The Board reviews before anything applies.
2. **Adoption pass** (ledger writes only — no external calls).
3. **Batched adds** under quota, spread across days if needed; normal per-add audit rows.

Batch sizes are set at implementation time against current Directory API quota documentation.

### 7.3 Quota assumptions

Nightly `listMembers` across every program group + members list + newsletter, plus `conversations.members` per Slack program. Fine at this org's scale, but quota limits are an operating constraint (backoff, batching), not a surprise.

## 8. Triggers

- **Nightly reconcile** is the backbone — full desired-state diff, guards, follow-ups, ghost detection, yearly notices, missed carry-over follow-ups.
- **Immediate triggers** (the `lib/programAnnounce.ts` shape) fire the relevant slice of reconcile after commit for: in-app opt-in/opt-out, Board intent actions, email change (§4), household status change, household archive and un-archive, and rollover. Anything a trigger misses, the nightly catches.

**Hook points:**

- **Household status** — `setHouseholdStatus` (`lib/membership/householdStatus.ts`), the one writer of `OrgMembership.status`. Activation, revoke, DENIED and the DENIED → NONE restore all pass through it, so no route can flip a status without the trigger firing.
- **Household archive** — `lib/household/archiveAction.ts` (archive and restore).
- **Email** — `Person.email` writers are the set `mailAliases.test.ts` discovers: the household and household-member routes, the two Board participant routes, `lib/auth-options.ts`, `lib/household/joinQuestion.ts`, `lib/membership/intake.ts`, `lib/person/ownHousehold.ts` and the merge executor. Most call `removeAliasesForSignInEmail` in their transaction; the merge moves aliases itself (`moveMailAliases`) and `ownHousehold.ts` leaves the call to its caller. The sync's after-commit email trigger is required at **every** discovered writer, those two included, and that test gains the assertion, so a new writer cannot skip it.
- **Merge** — the guard and the row move run inside the merge transaction (§4.1), not as a trigger.

### 8.1 Visibility — borrows the lifecycle oracle pattern, does not join the machine registry

Registering the ledger in `machineSpecs.ts` was considered and rejected: it is not a transition machine but a convergence ledger, and its interesting drift is against **external reality**, which `scanLifecycleViolations` cannot see (it validates DB rows only). The nightly reconcile *is* this design's drift detector. `SyncFollowUp`'s OPEN→ACK→RESOLVED ladder stays out for the same reason `PaymentException`'s does.

What it does take: the ops sync status surface is a `validate()`-style **invariant oracle** over `ListSyncState`, rendered as a sibling panel to `LifecycleDriftPanel` on system-status. Invariants that can rot silently:

- a `lastIntent = OUT` row with an applied add newer than `lastIntentAt` — the exact bug this design exists to prevent;
- an applied row with null `appliedEmail`;
- a DENIED or archived household's person with an applied newsletter row;
- more than one non-`RESOLVED` `SyncFollowUp` per `(kind, personId, targetRef)`;
- reconcile freshness — last successful run older than the cron cadence.

## 9. What this does *not* do

- **No auto-removal of members the sync did not add** — detection and a review screen only (§5).
- **No newsletter removal the person did not ask for, except DENIED or household archive**, and no re-add on restore (§2.3). A person's own opt-out or unsubscribe always removes them (§3.2).
- **No removal in the gap after an ongoing run ends** — its people stay until the next run starts (§2.6).
- **No auto re-add on coverage loss** (§3.5).
- **No parents-only / mentors-only lists yet** (§2.4).

## 10. Open questions

IDs are stable; a resolved question keeps its number.

1. **Cross-year opt-out identity.** Decided.
   - **Identity [Decision — owner, 2026-11-19]:** intent is keyed by the list address (or Slack channel id), not by program id. Teams reuse their address year over year, so an OUT carries to next year's run of the same team; a new address is a new list. Program and instance rows only decide who is *desired*, so the program→instance restructure changes `computeDesiredState` and nothing in the ledger.
   - **New-year handling [Decision — owner, 2026-11-19]:** yearly notice plus a Board action, for team lists and the members list only. The first time in a new membership year that the sync would have re-added a person whose OUT suppresses the add, it sends one email saying they are off that list and how to rejoin, stamps `lastNoticeYear`, and does not re-add them. A Board member can record an IN on the person's behalf when they ask in person (source `BOARD`, named actor, required note). The newsletter gets neither: an unsubscribe is a compliance matter and a reminder is itself unwanted mail.
2. **Slack boundary-removal grace.** Decided: no grace. Removal is immediate, with an audit entry (§3.6).
3. **Slack token provisioning.** Decided: people set up each program's Slack by hand, and an administrator pastes the bot key into a settings screen. A new IT Stewards role may edit integration settings only (§2.5).
4. **Reports API: attribution + timing.** Open. Can the Google Workspace Reports API (`activities.list`, groups application) reliably supply **who** performed a membership change (§3.3-3) and **when** (§3.2 ordering)? Attribution decides whether "external removal" can ever be narrowed to "self-removal"; timing makes intent ordering exact instead of window-based. Must characterize retrieval lag (no SLA) — the window tie-break stays as fallback regardless, and is permanent for Slack. Investigate before PR 3.
5. **Under-13 on lists.** Decided: no one under 13 on any app-managed list (§2.3).
6. **Host or package.** Decided [Decision — owner, 2026-11-20]: host code in `lib/sync/`, with the Google and Slack clients as two database-less packages (§1). No design yet says how programs, membership, households or people will be split into components; every input and hook point is host data; the merge guard must run inside the merge transaction, which only the host database gives; and the nearest precedents (receipt mail aliases, the QuickBooks posting queue) keep their state in the host. If Person later leaves the host, the sync moves with it.

## 11. Rollout

**Gate:** no PR below starts until the #1248 rollover design (runs, carry-over, `RESERVED`, the ongoing checkbox; §2.6) has shipped.

| PR | contents | inert? |
|---|---|---|
| B1 | Boundary PR: `defineOutbound` surfaces for Google Directory, Google Reports and Slack (tiered for the email addresses they carry) and their `egressAllowlist.ts` entries; registry entries + scope bindings for the sync-status, follow-up, Board-intent and integration-settings routes | yes |
| B2 | Boundary PR: the IT Stewards role and its grant, integration settings only (§2.5). Independent of the rest; lands before PR 4 | yes |
| 1 | `@checkin/google-workspace` and `@checkin/slack` client packages; the Google consent tool and refresher | yes — nothing calls them |
| 2 | Schema + `lib/sync/**`: desired-state engine, email-level diff, ledger incl. intent fields, merge guard and row move | yes, except the merge guard, which refuses nothing while the tables are empty |
| 3 | Intent model + classification guards + follow-up creation + ghost detection + yearly notice, with tests | yes |
| 4 | Wire-up: nightly reconcile, immediate triggers, screens (ops sync status; follow-up queues per audience; ghost review; coverage dashboard; Board intent action; Slack bot-key settings), adoption + staged bulk enrollment | **no** — first live behaviour |

B1 lands before PR 1, because the package egress files must already be on the allowlist. Any `src/security/**` change ships in its own PR (`security-boundary-isolation.yml`).

## 12. Testing

- **Unit — desired state:** the §2.3 rules: leads of an under-13 participant, a participant turning 13, leader + core volunteer, revoke mid-program, an archived household desired nowhere, carried-over `RESERVED` vs new `PENDING_*` vs `ACTIVE`, DENIED and archive recording the newsletter OUT.
- **Unit — runs and carry-over (§2.6):** a carried-over person counts as `RESERVED`, `PENDING_*` and `ACTIVE`; a new person only once `ACTIVE`; an ended ongoing run keeps its people until the next run starts; at the next run's start graduates, declined and released people drop; a next run with no carry-over drops no one and raises `CARRY_OVER_MISSED`; a run not marked ongoing drops at its end.
- **Unit — email-level diff:** the §4 swap yields exactly `{add C@, remove B_old}`; adds sequence before removes; `a.b+x@gmail.com` and `ab@gmail.com` compare equal.
- **Integration — OUT sticks:** an applied+desired row absent externally (guards passing) records OUT, writes one audit row, raises one audience-routed follow-up, and **no subsequent reconcile re-adds it**. That last assertion is the feature.
- **Integration — last intent wins:** external OUT then in-app IN (after observation) ⇒ re-added exactly once; an in-app IN inside the ambiguity window loses to the observed removal.
- **Integration — yearly notice:** a suppressed row in a new membership year sends one notice and stamps the year; a second reconcile that year sends none; no notice for the newsletter.
- **Integration — Board intent:** a Board IN without a note is refused; a Board IN on the newsletter is refused; a Board OUT records the actor.
- **Integration — restore:** DENIED → NONE and un-archive re-add no one to the newsletter; a later in-app opt-in does.
- **Integration — merge:** differing choices on one list refuse the merge and name the list; matching choices, or a row on one side only, move to the keeper.
- **Integration — guards:** absence with `emailUndeliverableAt` set ⇒ no OUT, a `DELIVERY_EJECT` follow-up, re-add after the stamp clears; absence with a changed email ⇒ propagation, no OUT.
- **Integration — adopt rule:** desired + present + no ledger row ⇒ ledger applied, zero external calls, zero audit rows.
- **Integration — follow-up idempotency:** repeated detection yields one non-RESOLVED `SyncFollowUp`; recurrence after resolution opens a new one.
- **Negative:** newsletter OUT records intent but writes **no** audit row and raises **no** follow-up; a program-list OUT routes to `PROGRAM_LEAD`, not `BOARD`.
- **Unit — sync oracle:** each §8.1 invariant flags a synthetic bad row and passes on a clean ledger.
- **Integration — Slack:** a person who stops being desired is removed at the next reconcile, with one audit row and no warning step.
- **Negative — under-13:** an in-app opt-in by a person under 13 is refused, and no reconcile adds them anywhere.
- **Integration-off:** every path is a no-op when `googleDirectoryConfigured()` is false.
