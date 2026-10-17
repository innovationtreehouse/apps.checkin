# Program withdrawal: an exit that leaves a trace

**Issue:** #1462 · **Status:** in-design (working doc). No production code
accompanies this doc. Do not cite it as ground truth.

Leaving a program hard-deletes the enrollment row. `withdrawAndReleaseHold`
([capacity.ts](../../checkin-app/src/lib/program/capacity.ts)) `delete()`s the
`ProgramParticipant`, and it is the only withdrawal path (a refund that Shopify
restocks deletes the row too, through `removeRefundedEnrollment`). So a person who withdrew and
a person who was never enrolled look identical afterwards: there is no row to
read. That is the gap — the system cannot tell "done" from "never here."

The fix is a single new state on the participant row. **Removal is not always a
withdrawal**, and this design leans on that:

- **Delete (never-there)** — the program hasn't started, or an early no-show. No
  participation happened; nothing is worth keeping. `delete()` stays, and with it
  today's exactly-once hold-ledger boundary — untouched.
- **Withdraw (was-here-then-left)** — real participation, then an exit. Record it
  and stop deleting.

But a withdrawn row is *still a row*, and most enrollment reads count rows, not
statuses. So the withdraw state is not "one line in the attached predicate" — it
is a new terminal present-row state that every enrollment-counting read has to
learn about (§6). That, plus the new ACTIVE-exit transition and the hold-release
ordering, is the real surface here.

The broader "done with the Treehouse" question — program-end cleanup, an
org-level exit stamp, youth graduation, and the volunteer/mentor side of the same
gap — is explicitly **not** here. See §8.

---

## 1. What the code does today

| Fact | Where |
|---|---|
| `ProgramParticipantStatus` is `PENDING \| ACTIVE` — no exit value | [schema.prisma](../../checkin-app/prisma/schema.prisma) `enum ProgramParticipantStatus` |
| `ProgramParticipant` PK is composite `@@id([programId, personId])` — one row per (person, program), ever | [schema.prisma](../../checkin-app/prisma/schema.prisma) `model ProgramParticipant` |
| The enrollment state machine's present-row states are `PENDING_UNPAID / PENDING_HOLD_FAILED / PENDING_HELD / PENDING_HELD_DENIED / ACTIVE`; `UNENROLLED` is the **no-row** (∅) state | [enrollmentState.ts](../../checkin-app/src/lib/programs/enrollmentState.ts) `STATES`, `LifecycleState` |
| Two transitions leave `ACTIVE`, both to `UNENROLLED` (no row): `T10 refund restocked` (Shopify webhook, `removeRefundedEnrollment`, no +1 because Shopify restocked) and `T11 withdraw(comp/approved)` (admin, `withdrawAndReleaseHold` `delete()`, +1 only when `seatTakenWithoutSaleAt` is set). The other withdraw transition is `T9 PENDING_HELD → UNENROLLED` via `delete()` | [enrollmentState.ts](../../checkin-app/src/lib/programs/enrollmentState.ts) transition table |
| `withdrawAndReleaseHold` `delete()`s the row; `delete()` **is** the exactly-once boundary for the scholarship-hold +1 and for T11's seat return | [capacity.ts](../../checkin-app/src/lib/program/capacity.ts) `withdrawAndReleaseHold` |
| `inventoryHeldAt` NOT NULL is "the transactional guard every release path checks before adjusting Shopify"; an ACTIVE row has it null by definition. An ACTIVE row's seat-return guard is `seatTakenWithoutSaleAt`: stamped when a comp, or an approved request whose hold was taken, took the seat out of Shopify without a sale. Withdrawal returns the seat only when it is set | [schema.prisma](../../checkin-app/prisma/schema.prisma) `ProgramParticipant.inventoryHeldAt`, `.seatTakenWithoutSaleAt` |
| CAS from-state guards spread `status` from `fromWhere(STATES[x])`, so every existing guard is implicitly `status:'PENDING'` or `status:'ACTIVE'` | [enrollmentState.ts](../../checkin-app/src/lib/programs/enrollmentState.ts) `fromWhere` |
| The attached-person predicate is a function of the clock, `programAttachedWhere(now)`. Its participant arm is `{ programParticipants: { some: { program: recentProgramWhere(now) } } }`: attached to a program that is current or ended within the lookback, in any enrollment status | [filters.ts](../../checkin-app/src/lib/person/filters.ts) `programAttachedWhere` |

**Two callers of the exit path, not three.** The issue body lists a "non-payment
kick" as a third deleting caller — that is stale. `cron/pending-participants` no
longer removes anyone; it warns the household and flags the board ("No longer
auto-removed — flagged for the board to act on",
[route.ts](../../checkin-app/src/app/api/cron/pending-participants/route.ts)). The
board then acts through the manual route. So `withdrawAndReleaseHold` has exactly
two live callers:

1. **Manual removal** — `DELETE /api/programs/[id]/participants`
   ([route.ts](../../checkin-app/src/app/api/programs/[id]/participants/route.ts), `DELETE`).
   Also where a board member acts on a flagged non-payment overdue.
2. **Grace-expiry** — `cron/scholarship-grace-expiry`
   ([route.ts](../../checkin-app/src/app/api/cron/scholarship-grace-expiry/route.ts)).
   The row sits in `PENDING_HELD_DENIED` the whole time: denied a plan, never
   paid, timed out.

## 2. The design

**One new enum value and one timestamp.**

```
enum ProgramParticipantStatus { PENDING  ACTIVE  WITHDRAWN }
```

Add `endedAt DateTime?` to `ProgramParticipant`. `WITHDRAWN` is the present-row
terminal state; `endedAt` gives the honest attachment *window* #1224 wanted for
the copy explaining why a person was flagged. Status alone can't say *when*.

**The withdraw path stops deleting; the delete path stays.** `withdrawAndReleaseHold`
splits by intent:

- `deleteAndReleaseHold(...)` — today's function verbatim, `delete()` and all. The
  never-there exits use it.
- `withdrawParticipant(...)` — sets `status = WITHDRAWN, endedAt = now()` and
  releases any held seat under the ordering in §4, keeping the row.

## 3. Which path each caller takes

`PENDING | ACTIVE` already encodes "were they ever really in," and both automatic
exits only ever touch `PENDING` rows. So:

| Caller | Path | Why |
|---|---|---|
| Grace-expiry cron | **delete** | `PENDING_HELD_DENIED` — never paid, never active, never participated |
| Manual removal, operator picks | **delete** or **withdraw** | Two buttons: *"never showed → remove"* vs *"withdrew → keep history"* |

The manual button's **default** falls out of the status: a `PENDING` row defaults
to *remove*, an `ACTIVE` row defaults to *withdraw*. The operator overrides only
the odd case (an `ACTIVE` person who genuinely never attended). This matches the
board-driven, out-of-band pattern the rest of membership enforcement already uses;
no attendance heuristic is invented here.

Net: the withdraw-with-history path is the manual one. The cron keeps deleting
exactly as today.

## 4. State machine + the exactly-once hold-ledger guard

`WITHDRAWN` is a new **present-row** state, distinct from `UNENROLLED` (∅). Add it
to the state set and add two transitions:

| New | Transition | Guard site |
|---|---|---|
| T10 | `withdraw(ACTIVE) → WITHDRAWN` | manual route — CAS `status:'ACTIVE' → WITHDRAWN, endedAt` (no hold to release; ACTIVE's `inventoryHeldAt` is null) |
| T11 | `re-enrol WITHDRAWN → PENDING_UNPAID \| ACTIVE` | enrol path — CAS `status:'WITHDRAWN'` (§5) |

Main already uses T10 and T11 for its two ACTIVE → UNENROLLED transitions (§1),
so these two need new numbers when built. Main's T11 also returns a seat on an
ACTIVE withdrawal when `seatTakenWithoutSaleAt` is set, so "no hold to release"
below does not hold for comp and approved places; the release ordering has to
cover that guard too.

T9 changes meaning: `withdraw(PENDING_HELD)` keeps the row as `WITHDRAWN` instead
of `delete → UNENROLLED`, and it is the one withdraw case that *does* release a
held seat.

**Why the release can't be a single conditional-on-`held` update.** My earlier
draft released with one CAS keyed on `inventoryHeldAt:{not:null}`. That is wrong
for the default case: an ACTIVE withdrawal has `inventoryHeldAt` null, so that CAS
matches zero rows and **the status never flips to WITHDRAWN.** Order it as two
steps:

```ts
// 1. Claim the withdrawal (idempotency boundary — replaces delete()'s role).
const { count: won } = await tx.programParticipant.updateMany({
  where: { programId, personId, status: { not: 'WITHDRAWN' } },
  data:  { status: 'WITHDRAWN', endedAt: new Date() },
});
if (won === 0) return { released: false }; // a concurrent caller already withdrew — no-op

// 2. Release a held seat exactly once, only if this row held one.
const { count: released } = await tx.programParticipant.updateMany({
  where: { programId, personId, inventoryHeldAt: { not: null } },
  data:  { inventoryHeldAt: null },
});
// released === 1 → do the Shopify +1 outside the tx. released === 0 → nothing was held.
```

Step 1's `status:{not:'WITHDRAWN'} → WITHDRAWN` is the new atomicity boundary that
`delete()` used to be: exactly one concurrent caller wins the flip, the rest see
`won === 0` and no-op — the same idempotent outcome the old P2025-on-second-delete
path gave. Step 2 clears the hold under its own CAS so the +1 fires once. Doing
step 1 first closes the window where a concurrent apply (`T3`/`T3m` stamping
`inventoryHeldAt`) could slip a hold in between a held-check and the write: once
step 1 has flipped the row to `WITHDRAWN`, no `PENDING`-gated apply guard can match
it (they all spread `status:'PENDING'` via `fromWhere`), so the hold state is
frozen before step 2 reads it.

**Manual-hold is already safe.** The T3m CAS at
[manual-hold/route.ts:134](../../checkin-app/src/app/api/finance-ops/payment-plans/manual-hold/route.ts)
spreads `fromWhere('PENDING_HOLD_FAILED')`, which pins `status:'PENDING'`. A
`WITHDRAWN` row can never match it, so it cannot be re-held — no extra guard
needed there.

## 5. Re-enrolment — the composite-PK consequence

The PK is `@@id([programId, personId])`: **there can only ever be one row per
person per program.** Today a re-enrol works because withdrawal deleted the row.
Keep the row and a re-enrol collides with the PK.

Resolution: **re-enrolment reactivates the existing row** (T11) — `WITHDRAWN →
PENDING_UNPAID` (or `ACTIVE` for a comp), run the normal capacity/hold logic —
rather than inserting. The enrol path becomes an upsert on the composite key.

A reactivation must **reset the prior stint's fields**, or the stale values join
the new stint to the old money:

| Field | Reset to | If not |
|---|---|---|
| `endedAt` | `null` | reads as still-withdrawn |
| `pendingSince` | `now()` | non-payment clock measures from the old stint |
| `isPaymentPlanRequested` | `false` | new stint inherits a stale plan request |
| `paymentPlanDeniedAt` | `null` | grace-expiry cron re-sweeps on an old denial |
| `wasOrgMemberAtApproval` | `null` | stale approval-time membership snapshot |
| `shopifyOrderId` | `null` | `reconcile.ts` ([:345/:450](../../checkin-app/src/lib/finance/reconcile.ts)) joins a later refund/chargeback on the **old** order to the new stint; `memberDiscountCode.ts` ([:64](../../checkin-app/src/lib/finance/memberDiscountCode.ts)) re-lends the old discount |

**A late refund or chargeback attaches to the withdrawn record.** A withdrawn row
keeps its `shopifyOrderId`, so the reconciler's match by order lands on the
`WITHDRAWN` row and records the refund or chargeback there, not as an orphan.
The row stays `WITHDRAWN`.

That needs a change to the refund path, because today it would delete the
row. `removeRefundedEnrollment`
([reversals.ts](../../checkin-app/src/lib/finance/reconcile/reversals.ts))
deletes by `programId`, `personId` and `shopifyOrderId` with no status filter, so
a late restocking refund on a withdrawn row's order would delete the record it
should attach to. The build must:

- add `status: 'ACTIVE'` to that function's `where`, so the refund-restocked exit
  (main's `ACTIVE → UNENROLLED`) only ever removes an `ACTIVE` row; and
- route a refund or chargeback that matches a `WITHDRAWN` row to attach to it,
  with an audit entry against the row and no delete. If the refund restocked,
  Shopify has put a unit back on sale for a seat the withdrawal may already
  have returned; the build checks that case and takes the extra unit back off
  sale, the same way the reconciler already handles restocked seats it cannot
  match to a child.

Once the person re-enrols, the reset above clears the old order from the row,
and a refund on that old order no longer matches the new stint.

<!-- ponytail: one row per (person, program) keeps only the LAST stint's exit.
     Multi-stint history (enrolled, withdrew, came back across years) would need a
     surrogate PK and a stint table — deferred until a consumer needs the full
     arc; BG/compliance only need current state. -->

## 6. Downstream: a withdrawn row is still a row

This is the load-bearing section. Narrowing `programAttachedWhere(now)` is necessary
but **not sufficient** — most enrollment reads count `ProgramParticipant` rows
filtered by `LIVE_PERSON` or nothing, never by status, so a `WITHDRAWN` row keeps
counting as enrolled everywhere until each site is taught otherwise.

Introduce a shared predicate next to `LIVE_PERSON` in `lib/person/filters.ts`:

```ts
export const ENROLLED_PARTICIPANT: Prisma.ProgramParticipantWhereInput =
  { status: { not: 'WITHDRAWN' } };
```

and a **drift guard** modelled on `livePersonDriftGuard.test.ts`
([src/__tests__](../../checkin-app/src/__tests__/livePersonDriftGuard.test.ts)):
grep every `prisma.programParticipant` read site in `src/app` + `src/lib` and fail
CI unless it references `ENROLLED_PARTICIPANT`/`status` or is allowlisted with a
justification (history/audit reads legitimately want withdrawn rows).

Sites that must adopt it (all confirmed status-blind on `main`):

| Site | Today | Effect if unfixed |
|---|---|---|
| `programAttachedWhere(now)` participant arm ([filters.ts](../../checkin-app/src/lib/person/filters.ts)) | `some: { program: recentProgramWhere(now) }`, status-blind | withdrawn people stay on BG + compliance chase lists |
| `capacity.ts:40` count | `person: LIVE_PERSON` | a withdrawn seat is consumed forever — contradicts §5 "run the normal capacity logic" |
| `programs/[id]/route.ts:250` | `person: LIVE_PERSON` | `maxParticipants` can't be lowered below withdrawn-inflated enrollment |
| `programs/mine/route.ts:19` | `personId in …` | withdrawn programs show in the household's "my programs" |
| `events/mine/route.ts:22` + `attendanceTransitions.ts:12` | `personId …` | a withdrawn person still resolves program events and **scans into them** |
| `eligible-participants/route.ts:30` | `NOT some{programId}` | withdrawn person is *excluded* from the eligible list, so the re-enrol UI can't reach them — must flip to allow WITHDRAWN back in |
| `personAgreementTriggers.ts:190` | `some: { program }` | withdrawn people keep getting agreement obligations |

Note `eligible-participants` is the inverse case: it wants to *stop* hiding a
withdrawn person so §5's re-enrol is reachable. The drift guard flags it; the fix
is per-site, not a blanket spread.

`enrollmentState.ts` T9 and the equivalence-oracle test assert `delete() =
atomicity boundary`; both move to the §4 CAS. Expect the oracle count and the
enrollment-state drift/mock tests to shift — full jest is the net, not tsc.

## 7. Migration & phasing

One additive migration: the new enum value and the nullable `endedAt`. Both are
backward-compatible with old code still serving traffic during the rolling deploy
— `WITHDRAWN` is never written by the old binary, and a nullable column defaults
to null. No backfill: existing rows are `PENDING`/`ACTIVE` and stay valid. The
predicate/`ENROLLED_PARTICIPANT` sweep, the write-path split, and the drift guard
ship in the same release as the migration, after it lands. See
`checkin-app/docs/DEPLOY_MIGRATION_ORDER_OF_OPERATIONS.md`.

## 8. Out of scope — spun off

#1462 is the participant withdraw exit state only. The rest of "done with the
Treehouse" is separate, each its own issue:

- **#1800** — program-end cleanup: stale rows nobody ever exits (program-lifecycle
  trigger, not a person action; narrows the predicate by program window). Composes
  with this: its `programAttachedWhere(now)` keeps `some: { program }`, this adds
  `status: { not: 'WITHDRAWN' }` in the same `some`.
- **#1801** — board "no longer with us" / "graduated" per-person org-level exit
  stamp (needs a board policy decision).
- **#1802** — school year / expected-exit year on youth (derived, youth-only).
- **#1803** — exit state for `ProgramVolunteer` and `Program.leadMentor` (the
  other two arms of `PROGRAM_ATTACHED_WHERE`, no scholarship-ledger coupling).
