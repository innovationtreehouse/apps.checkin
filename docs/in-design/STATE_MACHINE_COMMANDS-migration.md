# Cutover: state machines

The one-time part of `STATE_MACHINE_COMMANDS.md`: what exists today, the
household machine's PRs, and the order the other machines follow. Everything
here stops being true once the last machine converts. Its last step is "apply
the other file, delete both".

Counts are from `main` at `f8c4d4034`.

## 1. Where it stands

- Designed, not built. Open questions OQ1 to OQ4 are in the design file.
- The sealed client type (design 4.3) was prototyped against the generated
  Prisma client and compiled cleanly. The prototype was not committed.
- The household machine goes first. It needs no data migration and no release
  ordering.

## 2. What exists today

### 2.1 The four declared machines

| Machine | Rows | State columns | Edges | Writers today |
|---|---|---|---|---|
| Household (`OrgMembership`) | one per household | `status` | 8, no kinds | one helper, `setHouseholdStatus`, plus the dev seed |
| Application (`OrgMembershipProcess`) | one per application, check review or agreement | `status` | 60, of which 42 name no kind (32 not legacy) | 35 writes in 15 files |
| Enrollment (`ProgramParticipant`) | one per person per program | `status`, `inventoryHeldAt`, `isPaymentPlanRequested`, `paymentPlanDeniedAt` | 30 | `ENROLLMENT_WRITES` entries spread at 16 sites plus one create, in 5 API route files and 3 lib files; 3 moves are row deletes; `lifecycleDrift.ts` also clears a held seat directly |
| Program sale (`Program`) | one per program | none; derived from phase, enrollment status, dates | 10 | the programs routes and the sale sweep |

The sale machine has no column to seal: its state is computed from three
columns and the date. It is handled with the implicit columns (section 5.3).

### 2.2 The guards this work retires

- `lib/lifecycle/__tests__/noRawStatusWrites.test.ts` searches `src/` with
  regular expressions for writes to the four tables and checks each file against
  an exact-count allowlist.
- `lib/lifecycle/__tests__/guardFromStateParity.test.ts` checks a hand-kept
  `GUARDS` list against the transition table, per file.

Each machine's conversion deletes its part of both. The last conversion deletes
the files.

## 3. The household machine

### 3.1 Every status write

| Site | Today | After |
|---|---|---|
| `lib/membership/householdStatus.ts` `setHouseholdStatus` | the compare-and-set `updateMany` and audit row | deleted; the engine's `apply` does it |
| `lib/membership/householdStatus.ts` `ensureHouseholdMembership` | `createMany` at the default `NONE`, skipping duplicates | unchanged; it writes no `status`, so it compiles under the seal |
| `lib/dev/seed-helpers.ts:331`, `:357` | `upsert` with `status: "ACTIVE"` | fixture client (OQ4) |
| `lib/dev/seed-helpers.ts:600` | `create` with `status: "ACTIVE"` | fixture client |
| `lib/dev/seed-helpers.ts:240`, `:561`, `:575` | nested `household.create({ orgMembership: { create: { status } } })` | fixture client |

### 3.2 Commands and events

| Command | Where | Today | After |
|---|---|---|---|
| Board deny | `app/api/membership-ops/households/route.ts:317` | `setHouseholdStatus(tx, id, { from: [NONE, ACTIVE, REVOKED], to: DENIED })` | `apply(tx, HOUSEHOLD, id, "deny", …)` |
| Board restore | same route `:324` | `{ from: [DENIED], to: NONE }` | `"restore"` |
| Board revoke | same route `:372` | `{ from: [ACTIVE], to: REVOKED }` | `"revoke"` |
| Payment settles a cleared application | `lib/membership/payment.ts:266` | `{ from: [NONE, REVOKED, ACTIVE], to: ACTIVE }` | `"converge"` |
| A check clears on a paid application | `lib/membership/settleHouseholdBg.ts:300` | same | `"converge"` |

Each call site's `from` list is exactly the event's `from` in design 4.1, so no
command refuses in a case it accepts today. The route keeps the board-member
probe under the board-role lock, the conflict-of-interest check and the
post-commit `notifyBoardOfDenial`. The denial's in-transaction work
(`applyHouseholdDenial`) becomes the machine's `onEnter.DENIED` hook, which runs
in the same place it runs now.

### 3.3 Table changes

None to the moves. The eight edges become four events; `TRANSITIONS` is derived
from them. Event names change from prose ("application converges (paid + check
cleared)") to the identifiers above, so `docs/generated/lifecycle/household.md`
is regenerated in the same PR.

### 3.4 Tests

| Retired | Replaced by |
|---|---|
| `noRawStatusWrites`: "the household-status helper is the one OrgMembership status writer", and `OrgMembership` in its scan | Type assertions with the existing `Expect<Equal<…>>`: the sealed `orgMembership.updateMany` data's `status` is `WrittenOnlyByItsMachine \| undefined`, and so on for each write method and the nested relation |
| `guardFromStateParity`: the seven household `GUARDS` rows | The event union; a call naming a missing event does not compile |
| `householdStatus.test.ts`: the "undeclared edge throws" case | Engine unit tests: each event from each state, the no-op self move, a lost compare-and-set, the audit row, the hook |

A one-time test in PR 3 asserts that the derived table equals today's literal
`TRANSITIONS`; it is deleted with the literal in the same PR, once it has passed.

### 3.5 Measured size of the client switch

With only `OrgMembership` in the registry, switching `@/lib/prisma` and
`db-client.ts` to the sealed types gives:

- **Production code: 76 compile errors.** One is `setHouseholdStatus`'s own
  write, which is the point. The rest are typing: 17 `Prisma.TransactionClient`
  annotations in 12 files (both directions of assignment), the seed's own `Db`
  type in `seed-helpers.ts` and `prisma/seed.ts` (25), and the array form of
  `$transaction`, which the sealed type must add as an overload (2).
- **Tests: 76 files.** 166 errors are fixture writes of household status, 9 are
  nested household creates, and about 20 pass a mock typed with the full client.

With `OrgMembershipProcess` added as well, production code gives 111 errors and
tests about 410; the difference is the application machine's own 35 writes and
its fixtures, which wait for section 5.2.

### 3.6 PRs

Each is one PR, in order. None carries a migration, so none waits for a release
to reach production.

| PR | Contents | Behaviour change | Gate |
|---|---|---|---|
| 1. Engine and sealed type | `lib/lifecycle/machine.ts` (`defineMachine`, `transitionsOf`, `apply`, `create`) and `lib/lifecycle/sealed.ts` with an empty registry. Type assertions and engine unit tests against a test-only machine. | None; nothing uses them. | None |
| 2. Client switch | `@/lib/prisma` exports `SealedClient`; `TxClient` and `DbClient` become the sealed types; the 17 annotations and the seed's `Db` type change; `lib/dev/fixtureClient.ts`; the household fixture writes in tests and seed move to it. Registry still empty. | None at runtime; types only. | OQ4 answered |
| 3. Household machine | `HOUSEHOLD` events, derived `TRANSITIONS`, the five call sites on `apply`, `setHouseholdStatus` deleted, `OrgMembership: "status"` in the registry, the household parts of both scanner tests deleted, generated artifact regenerated. The `docs/conventions.md` change from OQ2 lands here. | None for users. A direct household status write anywhere now fails to compile. | OQ2 answered; PR 2 merged |

PR 2 is mostly mechanical but touches about 90 files. If it is too large to
review, split the test fixture moves into their own PR after it; the registry
stays empty until PR 3, so the order is safe.

## 4. How each PR meets the two bars

| PR | Bar 1 | Bar 2 |
|---|---|---|
| 1 | Inert. | Types and unit tests only. |
| 2 | No runtime change. | Replaces no guard yet; adds none. |
| 3 | Every event's source states equal what its call site passes today (3.2), checked by the one-time equality test (3.4); the refusals are today's. | Deletes the household half of two scanner tests; adds a type, a union and unit tests. |

## 5. The other machines, in order

### 5.1 Enrollment (`ProgramParticipant`)

Second, because it is the hardest test of the sealed type and the easiest of the
event table.

- **What is different.** Four state columns, not one: the registry entry is
  `ProgramParticipant: "status" | "inventoryHeldAt" | "isPaymentPlanRequested" |
  "paymentPlanDeniedAt"`. Its events are already named by outcome
  (`T4 activate(held)`), and `ENROLLMENT_WRITES` already pairs each compare-and-set
  with its data, so those entries become the event table nearly as they are.
- **The engine grows two things.** Multi-step events (`withdraw` writes the
  status, then releases a held seat), and removal: three moves delete the row, so
  the sealed delegate also removes `delete` and `deleteMany` for this model, and
  the engine gains `remove`.
- **API routes move behind commands.** Five route files write enrollment columns
  today (`request-payment-plan`, `finance-ops/payment-plans` and its `refuse` and
  `manual-hold`, and `participants`). Under the seal they must call commands in
  `lib/programs/`. This is the review's R6 in its real form; the two
  membership payment-plan routes it named write no `status`.
- **Risk.** Money: a seat held in Shopify is released or kept by these moves. The
  Shopify stock calls stay in the commands, beside `apply`, in the same order.
- **Retires** the enrollment parts of both scanner tests.
  `enrollmentGuards.integration.test.ts` stays; it runs the compare-and-set
  filters on Postgres.

### 5.2 Applications (`OrgMembershipProcess`)

Third, and in three steps, because it is the largest and the one with hidden
state.

1. **B, audit-log state into columns (OQ3).** B1 to B4 first. Each needs two
   releases, because old code keeps serving during a deploy and does not write
   the new column: the first adds the column, writes it alongside the audit row
   and backfills it from the audit rows; the second switches the reader. The
   second PR stays in draft until the first has reached production.
2. **A, outcome events (OQ1).** The seven fan-out pairs become outcome events;
   the 42 kind-less edges get explicit kinds. A one-time test asserts the derived
   table equals the old literal, as in 3.4. The recommendation H fix moves
   `recordRefund`'s household-conflict check inside its transaction here.
3. **D, the seal.** `OrgMembershipProcess: "status"` joins the registry and the
   35 writes go through `apply`. `settleHouseholdBg` becomes an orchestrator
   (recommendation G): it calls the application and household machines' events
   and writes neither column itself. The two payment-plan routes are untouched;
   they write a flag the machine does not own. The remaining scanner tests are
   deleted with this PR.

### 5.3 The implicit state columns

Last, and starting with an inventory (the review's R8), because none of these is
declared as a machine today:

- `Program` sale state: derived, so the candidates to seal are `phase` and
  `enrollmentStatus`, with the derivation kept.
- Receipt flow states, including `flow_error` and `ocr_queued`.
- `Disbursement` `RELEASED`.
- The enrollment heal in `lifecycleDrift.ts`, which changes a flag without a
  status move.

Each either becomes a machine under this design or is written down as
unmanaged, with the reason.

### 5.4 After the machines

- **F, an outbox for work after commit** (`notifyBoardOfDenial`,
  `settleAfterReview`): its own design, linked from #1305.
- **E, an optional log-only trigger** per sealed column, only if someone owns
  reading its output on System Status.

## 6. Last step

Move design sections 4.1 to 4.5 into `docs/architecture/STATE_MACHINES.md`,
confirm the conventions change from OQ2 is in `docs/conventions.md`, and delete
both files.
