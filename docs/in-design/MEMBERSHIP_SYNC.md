# Membership Sync — Google Groups (email) + Slack channels

**Status:** Design v2, for review. No code. Supersedes PRs #1156 and #1157 (both closed in favour of this doc) and replaces v1 of this doc after thpr review, 2026-07-22.
**Date:** 2026-07-22
**Purpose:** Keep Google Group membership (program groups, the members list, the newsletter) and Slack channel membership in step with who is actually enrolled and current — while treating a person's decision to join or leave a list as a first-class, auditable intent that the sync must never silently override.

This doc is written so an implementation session can pick it up cold. Read §1 for what is true today, §2 for the model, §3 for the intent/consent core, §10 for what is deliberately unanswered, then §11 for the PR sequence.

**Changes from v1 (thpr review, 2026-07-22):**

- Opt-out is **bi-directional** — in-app opt-out/opt-in is a first-class path alongside Google-side unsubscribe; last expressed intent wins (§3.2). v1's "no in-app clear path" is withdrawn: the real invariant was only ever "no *system* code path silently re-adds," which an authenticated, audited human intent does not violate.
- **Every** removal raises a follow-up, routed by audience (§3.4) — v1 raised one only for the members list.
- Newsletter removal has exactly one trigger: **DENIED** (§2.1) — v1's "never removed, ever" was wrong for barred persons.
- External-absence classification now has **guards** (bounce-eject, email change, actor attribution) before it counts as a choice (§3.3).
- Email changes propagate **actively**, and the reconcile diff runs at the **email level**, which also resolves the shared/swapped-address household case (§4).
- Ghost **detection** (externally-added unknowns) is in scope with a review screen; auto-removal remains out (§5).
- No auto re-add on household coverage loss — notification + board dashboard instead (§3.5).
- Population rules are now per-target and cover leads of under-13 participants (§2.3).
- Adoption rule + staged initial-enrollment plan added (§7); immediate triggers added alongside the nightly (§8).
- `SyncFollowUp` table decided (§6); `selfRemovedSource` dropped as redundant.

---

## 1. Current state

**Nothing ships today.** There is no Google Groups or Slack integration in `main`. Two PRs carried an earlier version of this feature and are now closed:

- **#1156** — schema (`SyncState`, `ProgramSlackAuth`), Google/Slack clients, desired-state engine. Inert; nothing called it.
- **#1157** — one line in `src/security/scopeBindings.ts` queueing `ProgramSlackAuth`, split out under the boundary-isolation rule.

Their engine design is carried forward here largely unchanged (§2). What changed is the intent/consent layer (§3–§5).

Relevant existing machinery this design reuses rather than reinvents:

- `AuditLog` (`actorId`, `action`, `tableName`, `affectedEntityId`, `oldData`, `newData`) — the app's existing audit trail. Note the `tableName` accuracy rule: a change to a `Person` column is filed under `Person`, not under whatever table the *route* is about (#1175, #1179).
- `BoardSettings.membersGoogleGroupEmail` / `.newsletterGoogleGroupEmail` — the two org-wide list addresses.
- `config.googleDirectoryConfigured()` — integration is OFF unless both the service-account key and the admin subject are set. Same null ⇒ off pattern as Resend and the s-read mirror.
- `Person.emailUndeliverableAt` — the bounce-tracking stamp maintained by the Resend webhook; consulted by this design's classification guards (§3.3).
- The announce-trigger helper pattern (#1194) — the shape for this design's immediate triggers (§8).

## 2. Core model (engine carried forward from #1156)

### 2.1 Desired state is a pure function

`computeDesiredState(now)` reads live rosters and memberships and emits the complete "who should be in what" tuple set on every run. It is **not** event-driven and keeps no bookkeeping of its own.

Everything awkward falls out of a plain diff against observed reality: program-boundary removal, membership lapse, and the youth reason-union need no special-case code. A tuple is `(personId, targetKind, targetRef, scope)`:

| targetKind | targetRef | scope | removal |
|---|---|---|---|
| `google_group` | program team-list email | `program:<id>` | on boundary, at next reconcile or immediate trigger |
| `google_group` | members list email | `org` | on boundary, at next reconcile or immediate trigger |
| `newsletter` | newsletter email | `org` | **only on DENIED** — never for lapse or any other reason |
| `slack_channel` | channel id | `program:<id>` | on boundary — grace period is an open question (§10.2) |

v1 said "immediate on boundary"; corrected — nothing runs between triggers. Removal happens at the next nightly reconcile, or sooner when an immediate trigger fires (§8).

**Dependency:** "membership lapse" means **manual revoke** for now. There is no GRACE/INACTIVE layer (backlog M1) and no automatic Sept-30 nonpayment signal; when M1 lands, its status transitions become additional inputs to `computeDesiredState` with no engine change.

### 2.2 `SyncState` is a cache, not a source of truth

One row per `(personId, targetKind, targetRef, scope)`. It records what was *applied* externally — **including the email address it was applied under** (`appliedEmail`) — the last error, retry state, provenance (`reasons`), and the person's last expressed intent (§3.2). Desired state is always recomputed live; the ledger never decides who belongs.

**The reconcile diff runs at the email level**, not the person level: per target, the desired email set (each desired person's *current* email) is compared against the observed member set (`listMembers` / `conversations.members`) and the ledger's applied emails. §4 explains why person-level diffing is not just weaker but wrong.

### 2.3 Population rules (per target)

- **Program team list** (`program:<id>`): every household lead of **any enrolled minor** (regardless of the minor's age), plus enrolled persons **13+** themselves, plus the program's lead and core volunteers. A household with only an 8-year-old enrolled is on the list via its leads — the younger the child, the more the parent needs the list.
- **Members list** (`org`): baseline desired set = the household leads of every ACTIVE household — minimum one per household (see §3.5 for what happens when opt-outs drop a household below that). Others — including 13+ youth — may join at their own discretion; there are no secrets on the members list. Discretionary joins arrive by hand (Google-side) or in-app opt-in and are respected per §3.2/§5.
- **Newsletter** (`org`): default = one household lead per family, opted in on activation (per CM10); anyone else opts in freely.
- **Under-13:** nobody under 13 is ever directly synced to any list. This is the deliberately conservative interim rule; whether an under-13 can *ever* be on a checkin-managed list is a **board decision**, tracked in the backlog DECISIONS file (SYNC-1). The board deciding otherwise changes §2.3 only.

### 2.4 Scope: the team list only, for now

This design models **one** Google group per program — the team list. The fuller CM6 shape (up to three lists per team: team / parents-only / mentors-only) is real, exists today outside checkin's control, and is **deliberately deferred** as a future feature. The tuple model extends to it without engine change (more `targetRef`s per program, role-filtered population rules).

List addresses live as **fields on `Program`** (team-list email now; parents/mentors fields when that future arrives). Slack configuration is its own table attached to `Program` (§6); a program "uses Slack" simply by having a row.

### 2.5 `ProgramSlackAuth`

Per-program Slack bot tokens live in their own table, never as a column on `Program` — otherwise every `program.findMany()` without an explicit `select` risks pulling a secret into memory. A separate table forces an explicit join. How tokens get provisioned is an open question (§10.3).

## 3. Intent, consent, and audit

The engine above is add/remove symmetric and has no opinion about *who* did the removing. This section is that opinion.

### 3.1 Every add is audited

Adding a person to a list is a real-world act — their address starts receiving mail. Each successful add writes an `AuditLog` row: actor (the sync's system actor), the target, and the reasons that made it desired.

**Exception: newsletter adds are not audited.** Add-only in practice, low-stakes, and would be the highest-volume audit source in the app for no investigative value. (Newsletter *intent* is still recorded in the ledger — an unsubscribe must stick — it just doesn't raise audit rows or follow-ups.)

### 3.2 Membership intent is first-class and bi-directional

A person's presence on a list reflects their **last expressed intent**, from either side, in either order:

- **OUT intent:** in-app opt-out, or an observed external removal (unsubscribe/leave) that passes the §3.3 guards.
- **IN intent:** in-app opt-in, or an observed external (re-)join — someone re-added by hand on the Google side, or rejoining a Slack channel, has expressed intent to be there; the sync adopts it and leaves them alone.

**The invariant:** no *system* code path may override the last intent. An OUT is never undone by a reconcile, a retry, a row rebuild, or an admin resetting sync state — only a **new, authenticated, audited IN intent** (the person in-app, or their own external re-join) clears it. That is the whole guarantee; an in-app path does not weaken it, because an in-app toggle *is* new intent, not a system override.

Ledger fields: `lastIntent` (`IN` | `OUT`), `lastIntentAt`, `lastIntentSource` (`APP` | `EXTERNAL`). While `lastIntent = OUT`, desired-state adds for that row are suppressed.

**Ordering external vs in-app intents.** Primary: if the Google Workspace **Reports API** (§10.4) yields a timestamped event for the external change, last-intent-wins is a straight timestamp comparison — no ambiguity. Fallback — when the event isn't available (Reports retrieval lag has no SLA; Slack's audit API is Enterprise Grid-only, so Slack never has one; lookup failure): the removal is only known to have happened "sometime since the last reconcile." In that ambiguity, **the removal wins** — removal is the more conservative choice: re-adding on the strength of an in-app opt-in that *might* predate the unsubscribe risks mailing someone after they asked out. The person's OUT stands; a new in-app opt-in *after* the observation is unambiguously later and wins normally. Worst case costs one extra opt-in click for someone who genuinely wants in; the compliance risk runs the other way.

When an in-window opt-in is overridden this way, the person's comm-settings toggle must not silently revert: the UI shows why — "your opt-in was superseded by an unsubscribe; opt in again to rejoin" — so the flip reads as a rule, not a bug.

### 3.3 Classification guards — before an external absence counts as OUT

An applied row whose email is absent from the external member list is **not automatically a choice**. In order:

1. **Bounce-eject.** If the person's `emailUndeliverableAt` is set, the absence is (or plausibly is) Google's automatic removal of a bouncing address — a delivery failure, not intent. No OUT is recorded; raise a `DELIVERY_EJECT` follow-up (§3.4) so a human fixes the address; the person is re-added once deliverability heals.
2. **Email change in flight.** If the person's checkin email differs from the row's `appliedEmail`, this is a propagation event (§4), not a removal. No OUT.
3. **Actor attribution.** The Groups API cannot distinguish self-removal from an admin removing them by hand. **Open (§10.4):** investigate the Google Workspace **Reports API** (admin audit events) for attribution before PR 2. Until resolved, the recorded event and audit language say **"external removal"** — never "self-removal" — because we genuinely don't know.

Only an absence that survives all three guards records `lastIntent = OUT` (`EXTERNAL`), writes an `AuditLog` row, and raises a follow-up.

### 3.4 Every removal raises a follow-up, routed by audience

Any OUT intent (either source) raises a `SyncFollowUp` (§6), routed to whoever should care:

| target | audience |
|---|---|
| members list | ops/board |
| program team list | that program's leader |
| newsletter | **nobody** — expected churn, no-op |

A member leaving the members list usually means something — a lapsed member, a disputed renewal, quiet disengagement. A person leaving a program list is something that program's leader needs to know: someone disengaged from *their* program.

### 3.5 Household coverage loss — notify, don't re-add

If OUT intents leave an ACTIVE household with **no lead on the members list**, the sync does **not** auto re-add anyone (the old "Rule A" idea, CM2, is explicitly rejected for now). It raises a `COVERAGE_DROP` follow-up → notification + board dashboard entry.

This is a customer-service problem until proven otherwise: we need to learn how often it happens and *why people leave* before building a heartless re-add machine. Revisit automation only after that evidence exists.

### 3.6 Slack, by symmetry

The same intent model applies to Slack: `conversations.members` gives the same observation capability `listMembers` does, detection and guards are symmetric, and an OUT suppresses re-invites identically. Hard (non-expiring) suppression is acceptable here **because** the re-add paths exist — rejoin the channel, or in-app opt-in — and the follow-up screens make the event visible. What is *not* settled is the boundary-removal grace period (§10.2).

## 4. Email change and the swap case

When a person's checkin email changes, every checkin-managed list and channel must be **actively** updated — immediate trigger on the change *plus* the nightly reconcile as backstop (belt and suspenders) — until the old address is fully cleaned out.

This is why the diff runs at the **email level** (§2.2). The hard case, which really occurs: household leads A and B, where A's address changes to `C@` and B's address changes to A's *old* address (some couples deliberately share one address — no secrets in the marriage). Per target:

- desired emails: `{C@, A_old}` (A's new, B's new)
- observed: `{A_old, B_old}`
- diff: **add `C@`, remove `B_old`** — and `A_old` never leaves the group; the ledger simply rebinds which person's row it is applied under.

Person-level diffing would misfire here (remove-then-re-add races, or worse, classifying A's "absence" as an OUT intent). Email-level diffing plus guard §3.3-2 makes the swap boring. The engine must sequence adds before removes within a target so shared addresses never drop off transiently.

## 5. Ghost detection — observed, surfaced, never auto-removed

The sync **never removes anyone it did not add** (unchanged from v1). But it now *detects* them: an address present externally that is neither desired nor in the ledger (and not a §3.2 adopted discretionary join of a known person) is a **ghost** — possibly innocent (a hand-added collaborator), possibly a problem (an expired member nobody removed, an unknown address).

- Ghosts appear on a review screen per target, routed like §3.4 (program list → leader; members list/newsletter → board).
- Removal from that screen is a deliberate admin action, audited, done via **checkbox selection** (including a select-all-in-header) — there is no "remove all ghosts" one-shot.
- Known-person external joins are not ghosts; they're IN intents (§3.2) and get adopted.

## 6. Data model changes

On `SyncState`:

| field | purpose |
|---|---|
| `appliedEmail` | the address the external add was applied under; drives email-level diffing (§2.2, §4) |
| `lastIntent` | `IN` \| `OUT` — last expressed intent (§3.2); `OUT` suppresses adds |
| `lastIntentAt` | when; used by the §3.2 tie-break |
| `lastIntentSource` | `APP` \| `EXTERNAL` |

(v1's `selfRemovedAt`/`selfRemovedSource` are subsumed: the intent triple replaces the sticky marker, and the google-vs-slack source was redundant with the row's `targetKind`.)

New table **`SyncFollowUp`** — modeled on `PaymentException`'s proven shape (kind/status/resolution) but with its own key and surfaces. Reuse of existing queues was considered and **rejected**: `PaymentException` is the wrong domain even with its `(kind, NULL)` unique-index defect fixed (sync items would live under Finance Ops); `IntegrationErrorLog`/Link Status is wrong twice over — a removal is not an *error*, and the audiences differ per target.

| field | notes |
|---|---|
| `kind` | `EXTERNAL_REMOVAL` · `COVERAGE_DROP` · `DELIVERY_EJECT` |
| `audience` | `BOARD` · `PROGRAM_LEAD` — drives which surface shows it |
| `personId`, `targetKind`, `targetRef`, `scope` | what happened where |
| `status` | `OPEN` · `ACKNOWLEDGED` · `RESOLVED` |
| `resolvedById`, `resolvedAt`, `resolutionNote` | resolve-with-note, like PaymentException |

Uniqueness: one non-`RESOLVED` row per `(kind, personId, targetRef, scope)` — nightly re-detection is idempotent; a later recurrence after resolution opens a fresh row.

Slack: a per-program config table (channel id + reference to `ProgramSlackAuth`), attached to `Program`; presence of a row = the program uses Slack. `Program` gains the team-list group email field (§2.4).

No change to `AuditLog`. Entries are filed under `tableName: "SyncState"` with the target in `newData` — the row genuinely is the thing that changed.

## 7. Adoption and initial rollout

### 7.1 The adopt rule

On reconcile: **desired + present externally + no ledger row ⇒ adopt** — write the ledger row as applied (with the observed email), no insert call, no audit row. This is how the first reconcile inherits today's hand-maintained groups without a wall of spurious "adds," and how a hand re-add on the Google side is honoured (§3.2 IN intent).

### 7.2 Initial bulk enrollment

The first live run against a large org is its own problem: Google sends group-subscription notification emails, the Directory API has write quotas, and it would be the highest-volume audit day ever. Plan:

1. **Dry-run report first**, per target: who would be adopted, who would be newly added, who looks like a ghost. Board reviews before anything applies.
2. **Adoption pass** (ledger writes only — free of external calls).
3. **Batched adds** under quota, spread across days if needed; normal per-add audit rows.

Exact batch sizes are set at implementation time against current Directory API quota documentation — the doc commits to the staging, not the numbers.

### 7.3 Quota assumptions

Nightly `listMembers` across every program group + members list + newsletter, plus `conversations.members` per Slack program. Fine at this org's scale, but the implementation must treat quota limits as an operating constraint (backoff, batching), not a surprise.

## 8. Triggers

- **Nightly reconcile** is the backbone — full desired-state diff, guards, follow-ups, ghost detection.
- **Immediate triggers** (the #1194 announce-helper pattern) fire the relevant slice of reconcile for: in-app opt-in/opt-out, email change (§4), activation, and DENIED. Belt and suspenders — anything a trigger misses, the nightly catches.

**Triggers hook the lifecycle machines' choke points.** The activation and DENIED triggers attach to the membership machine's transition helpers (`src/lib/membership/lifecycle.ts`) — the same choke points the lifecycle drift system guards — not to individual routes. No route can flip a status without the sync trigger firing, and when M1 adds GRACE/INACTIVE those transitions become sync inputs for free.

### 8.1 Visibility — borrows the lifecycle oracle pattern, does not join the machine registry

Considered and rejected: registering `SyncState` in `machineSpecs.ts` alongside enrollment and membership. It is not a transition machine — it is a convergence ledger, and its interesting drift is against **external reality** (Google/Slack), which `scanLifecycleViolations` structurally cannot see (it validates DB rows only). The nightly reconcile *is* this design's drift detector. `SyncFollowUp`'s OPEN→ACK→RESOLVED ladder stays out for the same reason `PaymentException`'s does.

What it does take: PR 4's ops sync status surface is a `validate()`-style **invariant oracle** over `SyncState`, rendered as a sibling panel to `LifecycleDriftPanel` on system-status — same shape, its own oracle. Invariants that can rot silently and earn a row there:

- a `lastIntent = OUT` row with an applied add newer than `lastIntentAt` — the exact bug this design exists to prevent;
- an applied row with null `appliedEmail`;
- a DENIED person with an applied newsletter row;
- more than one non-`RESOLVED` `SyncFollowUp` per `(kind, personId, targetRef, scope)`;
- reconcile freshness — last successful run older than the cron cadence (a silently dead cron is otherwise invisible).

## 9. What this does *not* do

- **No auto-removal of members the sync did not add** — detection and a review screen only (§5).
- **No newsletter removal except DENIED** (§2.1).
- **No auto re-add on coverage loss** (§3.5).
- **No parents-only / mentors-only lists yet** (§2.4) — future feature, engine-compatible.

## 10. Open questions

1. **Cross-year opt-out identity (the big one).** OUT intent is keyed by `scope = program:<id>`, but teams persist year over year with reused group addresses (backlog P25), and the P1 program→instance restructure may give each year its own id. Bind intent to the *team* and a parent who opted out once is suppressed years later for a different child; bind it to the *year-instance* and "permanent" silently resets annually. **No answer yet.** The P1 design must weigh in; this must be settled before PR 2's suppression semantics are final.
2. **Slack boundary-removal grace.** v1 carried "warn, then remove after 7 days" from #1156 without specifying who warns, on what channel (bot DM? email?), or the `warnedAt` state to track it. Keep the grace (and spec the mechanics) or simplify to immediate-with-audit, given re-add is easy (§3.6)? Undecided.
3. **Slack token provisioning.** Who installs the per-program bot and enters the token — an ops-facing surface, seed, hand-SQL? Must be specified before PR 3/4; no intent is currently known.
4. **Reports API: attribution + timing.** Can the Google Workspace Reports API (`activities.list`, groups application) reliably supply **who** performed a membership change (§3.3-3) and **when** (§3.2 ordering)? One investigation, two payoffs: attribution decides whether "external removal" can ever be narrowed to "self-removal"; timing makes intent ordering exact instead of window-based. Must characterize retrieval lag (no SLA) — the window tie-break stays as fallback regardless, and is permanent for Slack (audit API is Enterprise Grid-only). Investigate before PR 2.
5. **Under-13 on lists.** Board decision (backlog DECISIONS SYNC-1); interim rule in §2.3.

## 11. Rollout

| PR | contents | inert? |
|---|---|---|
| 1 | Schema + `lib/sync/**`: desired-state engine, email-level diff, clients incl. `listMembers`/`conversations.members`, ledger incl. intent fields | yes — nothing calls it |
| 2 | Intent model + classification guards + follow-up creation + ghost detection, with tests | yes |
| 3 | Boundary PR: registry entries + scope bindings for the sync-status and follow-up routes (isolation rule) | yes |
| 4 | Wire-up: nightly reconcile, immediate triggers, screens (ops sync status; follow-up queues per audience; ghost review; coverage dashboard), adoption + staged bulk enrollment | **no** — first live behaviour |

Ordering constraint carried from #1157: any `src/security/**` change ships in its own PR (`security-boundary-isolation.yml`).

## 12. Testing

- **Unit — desired state:** pure-function tuple sets for the §2.3 rules: leads of an under-13 participant, a participant turning 13, lead + core volunteer, lapse-by-revoke mid-program, DENIED dropping the newsletter row.
- **Unit — email-level diff:** the §4 swap (A→`C@`, B→`A_old`) yields exactly `{add C@, remove B_old}`; adds sequence before removes; no transient drop of a shared address.
- **Integration — OUT sticks:** an applied+desired row absent externally (guards passing) records OUT, writes one audit row, raises one audience-routed follow-up, and **no subsequent reconcile re-adds it**. That last assertion is the feature; a test checking only the first reconcile passes against a broken implementation.
- **Integration — last intent wins:** external OUT then in-app IN (after observation) ⇒ re-added exactly once; an in-app IN timestamped *inside* the ambiguity window loses to the observed removal (§3.2 fallback — removal is the more conservative choice) and the person stays out until they opt in again.
- **Integration — guards:** absence with `emailUndeliverableAt` set ⇒ no OUT, a `DELIVERY_EJECT` follow-up, re-add after the stamp clears; absence with a changed checkin email ⇒ propagation, no OUT.
- **Integration — adopt rule:** desired + present + no ledger row ⇒ ledger applied, zero external calls, zero audit rows.
- **Integration — follow-up idempotency:** repeated nightly detection of the same event yields one non-RESOLVED `SyncFollowUp`; post-resolution recurrence opens a new one.
- **Negative:** newsletter OUT records intent but writes **no** audit row and raises **no** follow-up; a program-list OUT routes to `PROGRAM_LEAD`, not `BOARD`.
- **Unit — sync oracle:** each §8.1 invariant flags a synthetic bad row and passes on a clean ledger; the panel and any future reconciler consume the same oracle (the `lifecycleDrift` never-re-derive rule).
- **Integration-off:** every path is a no-op when `googleDirectoryConfigured()` is false.
