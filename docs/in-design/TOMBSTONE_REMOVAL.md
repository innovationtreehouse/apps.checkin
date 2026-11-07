# Remove `LIVE_PERSON`: tombstone exclusion becomes structural

Issue: [#1456](https://github.com/innovationtreehouse/checkin/issues/1456)

## Problem

When two duplicate person records are merged, the loser is not deleted — it stays in the database
forever as a "tombstone". Every part of the app that reads people therefore has to remember to
exclude tombstones, or it silently shows and counts a person who no longer exists.

Remembering is left to the developer. There are **about 150 places** that have to get it right,
across about 75 files. Getting it wrong produces no error of any kind — just a ghost in a roster, a wrong count, or
a write that lands on a dead record.

It has gone wrong repeatedly. Three bugs shipped and were fixed one at a time; then the automated
check that should have caught them was widened, and found **13 more live defects in a single sweep**
— including an authorization check that a merged-away identity could satisfy. It also surfaced a
safety question nobody can answer cleanly: a merge can leave someone's open building visit attached
to the deleted record, so the evacuation roster must choose between showing a ghost and reporting a
household absent while a person is still inside.

## Objective

**Make it impossible to read a merged-away person, rather than everyone's job to remember not to.**

Concretely: delete the `LIVE_PERSON` filter and its drift guard, by removing the tombstones they
exist to hide.

## Executive summary

| | |
|---|---|
| **The fix** | Stop creating tombstones. The merge either absorbs the loser completely or refuses to run. |
| **Why that's possible** | The merge already moves everything to the survivor. Rows are left behind in one situation only: a unique-constraint collision (the same human enrolled in the same program twice). |
| **What board members see** | Merges get stricter: "unenroll one of these from Program X first." Clear-up surfaces already exist for nearly all cases. |
| **What developers stop doing** | Remembering `LIVE_PERSON` on about 150 queries. It, the drift guard, and its 34-entry allowlist all get deleted. |
| **What replaces the tombstone** | A `PersonMerge` record (from, to, when, snapshot). Badge scans and audit history keep working. |
| **Done when** | No `Person` row has `mergedIntoId`; the column, the filter, and the guard are gone. |
| **Deliberately not included** | #1134 (permission-based row visibility) and #1228 (`archivedAt`). See [Out of scope](#out-of-scope) — this issue has to be able to close. |

The trade being made: **merges become harder in exchange for the whole bug class disappearing.** A
merge that today silently parks an ambiguity now stops and asks a human to resolve it first — which
is also the better answer on its own merits, since the ambiguities are things like "which of these
two tool certifications is real".

## How it breaks today

`LIVE_PERSON` ([`lib/person/filters.ts`](../../checkin-app/src/lib/person/filters.ts)) is
`{ mergedIntoId: null }` — an **opt-out** convention. A merged-away Person is a tombstone: the row
survives forever, so every Person query must remember the filter or silently read a ghost.

**About 150 usages across about 75 files, plus a 34-entry allowlist** on the drift guard (counted
on `main`, 2026-10-16, production code only, imports excluded). Forgetting produces no
compiler error and no runtime error — a stale row in a list, or a write landing on a dead record.

### The failure rate is the argument

Three bugs shipped and were fixed individually:

| Bug | Effect |
|---|---|
| [#1448](https://github.com/innovationtreehouse/checkin/pull/1448) | The merge's own lead-count guard counted tombstones, **falsely blocking** legitimate merges with a message naming members that don't exist |
| [#1450](https://github.com/innovationtreehouse/checkin/pull/1450) | Tombstones leaked into the "needs a lead" household surfaces |
| `review.ts:305` | The background-check blanket stamp (fixed under [#1260](https://github.com/innovationtreehouse/checkin/issues/1260)) |

`livePersonDriftGuard.test.ts` (since retired) was written to catch precisely this class and **missed all three** — its
matcher saw only read verbs on the `person` delegate, so a `person.updateMany` and a Person-typed
relation named `householdMembers` were both invisible.

**Then [#1455](https://github.com/innovationtreehouse/checkin/pull/1455) widened it, and the true
size showed: 19 sites flagged, 13 of them silently wrong.** Not stylistic — among them:

- **An authorization check a merged-away identity could satisfy.** `membership/request-payment-plan`
  tested household leadership with `some(p => p.id === currentUserId)` over an unfiltered lead set.
- **A lead lookup a tombstone could shadow entirely** — `finance-ops/payments` pulls with `take: 1`.
- **Tombstone contact addresses presented as people to contact** — the merge rewrites the loser's
  email to `merged-*@deleted.invalid`, and household rosters and lead-contact lists displayed it.

That is the case for this issue. Three bugs is a run of bad luck; **13 live defects sitting behind
one filter nobody could see they had missed is a design that does not work.** Every one is a place a
developer had to remember something, and didn't — which is what an opt-out convention guarantees at
scale.

**#1455 is mitigation, not the fix.** The guard is a regex over source text: it now sees two more
shapes, and the next blind spot is a matter of time. It also cannot answer the questions it
surfaces — see [the safety surface it could not decide](#the-question-the-model-cannot-answer).

### The question the model cannot answer

The widened guard left `safety/emergency-contacts` deliberately unfiltered, marked `NEEDS REVIEW`.
It is the evacuation roster: `isPresent` derives from each member's open `visits`, and a merge can
leave a concurrently-open visit on the **tombstone**.

So filtering trades a duplicate ghost row against **reporting a household absent while someone is
still in the building**. Neither answer is safe, and a drift guard has no business choosing.

This is the sharpest argument for removal. The dilemma is not inherent to evacuation rosters — it
exists *only* because a merge can strand a live visit on a record that still looks like a person.
Remove tombstones and the question does not get answered; it stops existing.

## Why the tombstone exists — and why it needn't

The merge already **repoints** to the survivor: visits, plus `programParticipant`,
`programVolunteer`, `rSVP`, `toolStatus`, `backgroundCheckAttestation`,
`corporationLead`, `corporationMember`, and a further set via straight `updateMany` (`account`,
`orgMembershipProcess`, `program.leadMentorId`, `trustedAdult` ×2).

Rows stay behind in exactly one situation: a **unique-constraint collision** — the same human holds
a row on both records for the same program / event / tool / process, so the FK cannot be repointed.
When this doc was written the merge route stated the coupling outright:

> leave the colliding row on the tombstone (both survive; §3's LIVE_PERSON filter excludes the
> tombstone's from every count/roster)

On `main` the decision-bearing collisions are refused before the merge runs (§1, shipped), and the
merge route's `POST` handler keeps a `left` fallback only as defense against a race between the
check and the write
([`merge/route.ts`](../../checkin-app/src/app/api/membership-ops/participants/merge/route.ts)).

That is the whole dependency. The tombstone is **a parking space for collision residue**, plus a
redirect target for badge scans. Neither job requires it to be a `Person` row — and the parking
space is what forces about 150 call sites to know about it.

## Design

### 1. Merge refuses ambiguity instead of parking it

Shipped in #1686: the merge refuses the collisions marked **refuse** below and auto-dedupes the bare
joins.

**Rule: refuse when the collision carries a decision; auto-dedupe only bare join rows with no
distinguishing payload.**

| Collision | Verdict | Rationale |
|---|---|---|
| `BackgroundCheckAttestation` | **refuse** | Means one human attested twice under two identities — the exact thing the two-distinct-reviewer rule forbids. A conflict-of-interest signal to investigate, not reconcile. Dropping one row also changes the approval count, which can retroactively clear or un-clear a check. |
| `ProgramParticipant` | **refuse** | Seat, payment, and downstream RSVPs. "Unenroll one of these from Program X first." |
| open `Visit` on both | **refuse** | "Close one of these visits first" — strictly better than the three bad alternatives below. |
| `ToolStatus` | **refuse** | Highest-wins is tempting, but silently raising a machinery certification during a data-hygiene operation is the wrong place for that to happen. |
| `RSVP` | **refuse — future events only** | Two answers to one upcoming event needs a human. A past event's RSVP is inert. |
| `ProgramVolunteer`, `CorporationLead`, `CorporationMember` | **auto-dedupe** | Bare join, no payload, same human, same entity. Nothing to decide. |

This inverts the model: today the merge absorbs everything and `LIVE_PERSON` cleans up after it
forever; here the merge is a **precondition-checked operation that either completes cleanly or
refuses**. [#1451](https://github.com/innovationtreehouse/checkin/pull/1451) ("refuse a person merge
across mismatched household membership") is the same pattern already landing — match its shape.

**Refusal is only viable if every refusable condition has a cleanup path.** Verified present:
`DELETE /api/programs/[id]/participants`, `/api/events/[id]/rsvp`, `/api/shop/certifications`,
`/api/attendance/manual/[id]`. **One gap:** `BackgroundCheckAttestation` has no user-facing removal —
attestations are deleted only by `boardResetReview` and a rejector's change to approve. A
refusal there is currently a dead end. Given what that collision signals, a sysadmin-only path with
an audit trail is probably right, but it must be built or those merges become impossible.

**The error message is the feature.** "Cannot merge" without naming the exact program, event, or
visit — and linking to where to fix it — converts a good invariant into a wall.

### 2. Resolve the existing stock

Refusal fixes the **flow**, not the **stock**: every tombstone already carrying parked residue from a
past merge still needs one-time resolution. The widened drift guard's allowlist is the scoping input
— each entry is a code path that depends on tombstones existing today.

Per the per-adult background-check work (#1470, shipped), prefer an in-app worklist over a
script if the volume warrants a human decision per row; a pure count of collisions should be gathered
first to decide which.

### 3. Archive, then delete

With no dependents, the tombstone becomes a record rather than a row:

```prisma
model PersonMerge {
  id        Int      @id @default(autoincrement())
  fromId    Int      // the merged-away person's original id — no FK; the row is gone
  toId      Int
  to        Person   @relation(fields: [toId], references: [id])
  mergedAt  DateTime @default(now())
  snapshot  Json     // identity fields as they stood, for audit
}
```

- **Badge scan** resolves a badge through `resolveMergedPerson`
  ([`lib/person/mergeChain.ts`](../../checkin-app/src/lib/person/mergeChain.ts)), which already
  follows both `mergedIntoId` and `PersonMerge`; dropping the tombstone leaves only the archive arm.

On `main` every merge writes a `PersonMerge` row (#1729) and deletes the merged-away `Person` row
in the same transaction (2b-3). A data migration deletes each existing tombstone that has an
archive row and no remaining reference; any it keeps stay listed on the census page.
- **`AuditLog.affectedEntityId`** is a bare `Int` with no FK, so historical audit references survive
  a deleted `Person`.
- `Person.mergedIntoId`, `mergedInto`, and `mergedFrom` are dropped.

### 4. Delete the guard

`LIVE_PERSON` goes. `livePersonDriftGuard.test.ts` and its 34-entry allowlist are already retired (pass D1: once merges delete the row, no tombstone can exist for the guard to protect against). Every one of the
roughly 150 call sites loses its filter — mechanical, and `tsc` catches the import removals.

## Decisions needed (policy, not plumbing)

1. **Per-table collision rules.** The table above is a proposal; the `ToolStatus` ladder (`DOF`
   outranks `CERTIFIED` despite the enum declaration order) and the `ProgramParticipant`
   seat/payment interaction want their owners' sign-off.
2. **The open visit.** When this doc was written the merge deliberately left the tombstone's open
   visit when the keeper already had one — *"no delete, no fabricated departedAt"*, with a
   `ponytail:` note preferring the left row to an invented departure time. On `main` the merge
   refuses up front when both have an open visit (the `openVisit` collision); the visit move in
   [`merge/route.ts`](../../checkin-app/src/app/api/membership-ops/participants/merge/route.ts) still
   leaves the tombstone's open visit behind if one opens between that check and the write. Removing tombstones forces the question: fabricate a `departedAt` (what the code refuses),
   move it and hold two open visits (breaks the invariant), or delete an attendance record (a safety
   record in a youth organisation). Refusing the merge until the visit is closed is the proposed
   answer, and it is the only one that invents nothing.
3. **The attestation cleanup path** (see the gap above).

## Out of scope

- **[#1134](https://github.com/innovationtreehouse/checkin/issues/1134) declarative row visibility.**
  Similar-looking, different mechanism. #1134 is **permission** — *which rows a given caller may
  see*, per-caller and contextual, the row analogue of `@sensitivity`. Tombstone exclusion is
  **caller-independent**: a tombstone is never visible to anyone, ever. Folding this into #1134 would
  make both larger and neither closeable. Deliberately separate.
- **[#1228](https://github.com/innovationtreehouse/checkin/issues/1228) `Household.archivedAt`.** A
  second exclusion dimension. Built the current way it would mint a second forgettable convention and
  a second drift guard — worth a comment on that issue **once this design is agreed**, not folded in
  here.
- Any general soft-delete or archival framework. This issue closes when `LIVE_PERSON` is gone.

## Migration / safety notes

- **Live data.** Deleting `Person` rows is irreversible; the archive write and the delete must be one
  transaction, and the stock resolution (§2) must complete and be reviewed before any delete runs.
- **Dropping `mergedIntoId`** is a destructive schema change and lands last, after §1–§3 are live and
  the column reads zero. It touches the security boundary (generated classifications, `scopeBindings`)
  and therefore ships in its own PR per the boundary-isolation rule in `AGENTS.md`.
- **Ordering vs. #1454.** `review.ts:305`'s `LIVE_PERSON` omission is fixed independently there; no
  conflict, and this design removes the need for that filter entirely once it lands.
- **`tsc` is not sufficient** for §1. The collision rules are behavioural; they need integration
  coverage per table, including the refuse-path assertions.

## Test plan

- Each collision class: merge refuses, with the refusal naming the specific colliding entity.
- Each auto-dedupe class: merge completes, one row survives, no residue on either record.
- After a successful merge: **the merged-away `Person` row no longer exists**, and a `PersonMerge`
  row records it.
- Badge scan against a merged-away id resolves to the survivor via `PersonMerge`, including the
  multi-hop chain the current `mergedIntoId` walk caps.
- An `AuditLog` row referencing a deleted person still renders.
- Regression: the three shipped bugs (#1448, #1450, `review.ts:305`) become **unrepresentable** — no
  tombstone exists to count, list, or stamp.
