# Cutover: programs state the membership year they run in

Everything here expires when the change has run. The design is in
`PROGRAM_MEMBERSHIP_YEAR.md`.

## Where it stands

Five pull requests finish this; none has started. The date half of the original
design has shipped: every program has a start and an end date, the create and
edit routes refuse one without both, and `programCoverageDate` returns the end
date. What remains is the stated year and everything that reads it.

Two of the five wait on owner decisions (`PMY-Q1`, `PMY-Q2`); one more takes its
scope from `PMY-Q3`. None waits on the settlement-year work (#1655) or on the
program restructure.

## Decisions settled

- **The revenue effect of stating a crossing program as the earlier year** is
  carried by the board's budget approval, which is where the year is decided. It
  is not a new discretionary power.
- **Legacy programs that cannot be filled in** surface as a red badge and a nav
  count in the broken-checkout style, not as a report.
- **A boundary that moves** is out of scope, as an assumption.
- **No program is created or re-dated before the boundary is set.**
- **The field is `appliesToYear`**, the opening-year integer, shared with the
  settlement-year work.

## Open questions

Stable IDs; a resolved question is marked in place, never renumbered.

- **`PMY-Q1`: Who may state or change a program's year?** A program leader can
  edit dates today; the stated year decides who gets the member price; only the
  board and sysadmins set price. *Recommendation:* the board and sysadmins only. A
  leader's date edit that stays inside one year still re-derives silently; one
  that would need a new statement is refused with "ask the board to set the
  membership year". Blocks PR 3.
- **`PMY-Q2`: Can the stated year change once someone has paid for a place?** The
  member-code check runs again when an order arrives and when the board
  reconciles, against the year as it stands then, so a change after payment can
  turn an order that was correct when placed into a payment problem.
  *Recommendation:* refuse the change once any place is paid; a board that really
  needs it handles the paid families by hand first. Blocks PR 3.
- **`PMY-Q3`: Which programs must have a stated year?** *Recommendation:* only
  programs that have not yet ended. An ended program's year is read again only
  when one of its old orders is reconciled, and the end date it falls back to is
  the stricter reading. Under this answer the column stays nullable and the
  end-date fallback stays, so there is no contract step. If the answer is every
  program, PR 6 below is added. Sets the scope of PR 5.

Only production can say how many existing programs cross the boundary. PR 4
leaves them empty and PR 5 counts them.

## Build plan

Each PR is shippable on its own and green on its own. No step adds a route, so no
registry or security-boundary PR is needed; the regenerated classifications in
PR 1 are a pure addition, which the boundary-isolation check accepts alongside
schema changes.

Order: **1 → 2 → 3 → 4 → 5.** PR 2 goes before PR 3 because it is unblocked and
behaves exactly as today until rows carry a year. PRs 2 and 3 both edit
`checkin-app/src/app/api/programs/[id]/route.ts` (PR 2 the `GET`, PR 3 the
`PATCH`), so they are not built at the same time.

### PR 1: schema expand [mig]

- **Files:** `checkin-app/prisma/schema.prisma` (`appliesToYear Int?` on
  `Program`, with `/// @sensitivity:public`); a new migration
  `ALTER TABLE "Program" ADD COLUMN "appliesToYear" INTEGER;`; regenerated
  `checkin-app/src/security/generated/classifications.ts`.
- **Tests:** unit (`npm run test:ci`); the classification drift tests are the net.
- **Migration safety:** additive and nullable; the old release ignores it for the
  whole drain window. No index: nothing filters on it except the PR 5 count over
  a small table.
- **Blocked on:** nothing. If the restructure's run-columns migration has landed
  first, add the column to `ProgramInstance` in the same migration and to its
  re-sync.

### PR 2: coverage reads the stated year [app]

- **Files:** `checkin-app/src/lib/orgMembership.ts`: `programCoverageDate` takes
  `{ endAt, appliesToYear }`, reads the boundary, and returns the boundary that
  closes the stated year, or `endAt` when no year is stated or no boundary is set.
  It becomes async. Its four callers:
  `checkin-app/src/app/api/programs/[id]/discount-code/route.ts`;
  `checkin-app/src/lib/programs/memberDiscountCode.ts` (add `appliesToYear` to its
  `select`); `checkin-app/src/app/api/programs/[id]/route.ts` `GET` (add
  `appliesToYear` to the `getProgram` select, so it rides in the body the wrapper
  rebuilds from); `checkin-app/src/lib/notifications.ts` (its type widens; the
  edit route already passes the whole row).
- **Rules:** this PR makes the pricing rule true, so it applies the Pricing block
  in [Destination](#destination-docsrulesprogramsmd) and deletes the candidate
  block.
- **Tests:** unit for the horizon (the equivalence cases in the design), the
  discount-code route and the entitlement check for a crossing program stated as
  the earlier year. Run the full `npm run test:ci`, not a narrowed one: the
  horizon now reads `boardSettings`, and every test that mocks prisma for one of
  the four callers without a `boardSettings` mock fails at runtime while tsc
  stays green. Grep all three test roots for the callers and add the mock.
- **Migration safety:** none; no schema change. With every row empty it behaves
  exactly as today.
- **Blocked on:** PR 1.

### PR 3: write path and the form field [app]

- **Files:**
  - `checkin-app/src/lib/programYear.ts`: the two pure helpers, the year a date
    falls in (with the end-date rule from the design) and the `2026-2027` label,
    plus the years a pair of dates touches. Skip any the settlement-year work has
    already written.
  - `checkin-app/src/app/api/programs/route.ts` `POST` and
    `checkin-app/src/app/api/programs/[id]/route.ts` `PATCH`: refuse with a message
    naming the setting when no boundary is configured; derive the year when the
    dates decide it; otherwise require one of the years the dates touch, keeping a
    still-valid stated year across a date edit. Apply `PMY-Q1` and `PMY-Q2`.
  - `checkin-app/src/app/program-ops/new/page.tsx` and
    `checkin-app/src/app/program-ops/programs/[id]/page.tsx`: the conditional
    select, labelled to point at the budget approval. The settings form's
    `startAt`/`endAt` types are still `string | null`; tighten them while there.
  - Seed: `checkin-app/prisma/seed.ts` writes the `BoardSettings` boundary at the
    policy value (1 September), and `createProgram` in
    `checkin-app/src/lib/dev/seed-helpers.ts` derives the year. Without the
    boundary, program creation fails on every dev instance and in the flow tests.
  - Flow tests: `checkin-app/flow-tests/program-member-pricing.flow.test.ts`
    creates a program from 1 January to 31 December, which crosses a September
    boundary, so it must supply a year. `expense.flow.test.ts` also creates
    programs.
- **Rules:** applies the "states a year" and "not before the boundary" lines and
  both Assumptions from the Destination.
- **Tests:** unit for the helpers and both routes; then the flow suite
  (`npm run test:flow:standalone`, a heavy run). Seeding a boundary turns coverage
  horizons on everywhere in the seeded data: a seeded household with an ACTIVE
  membership and no settled dues process becomes covered only to the past
  boundary, so member-pricing expectations in any flow suite may flip. Run the
  whole flow suite, not the one file.
- **Migration safety:** none. During the drain window the old release still
  creates programs with no year; PR 4 fills those.
- **Blocked on:** PR 1, `PMY-Q1`, `PMY-Q2`.

### PR 4: fill existing rows [mig]

- **Files:** one migration whose SQL sets `appliesToYear` on every program that has
  none and whose dates fall in one membership year, reading the boundary's month
  and day from the `BoardSettings` row; it does nothing when no boundary is set.
  Wrap it in `BEGIN;`/`COMMIT;` and mark the block for extraction, as the
  restructure's first migration does.
- **Tests:** an integration test (`npm run test:integration` narrowed to one path,
  a heavy run) that extracts the block and runs it twice: it fills what the dates
  decide, leaves crossing programs empty, honours the boundary-day end rule, and
  changes nothing the second time.
- **Migration safety:** it updates only empty rows and is idempotent. It must
  deploy in a release after PR 3, so rows the old release wrote during PR 3's
  drain are covered.
- **Blocked on:** PR 3 deployed.

### PR 5: programs that need a person [app]

- **Files:** `appliesToYear` added to `PUBLIC_PROGRAM_SELECT` in
  `checkin-app/src/app/api/programs/route.ts`; the badge in
  `checkin-app/src/app/program-ops/programs/page.tsx` and
  `checkin-app/src/app/program-ops/programs/[id]/page.tsx`, beside the
  broken-checkout one; the count in `checkin-app/src/lib/nav/todoCounts.ts` beside
  `programsMisconfig`, and its pill via `checkin-app/src/components/navBadges.ts`.
  Under `PMY-Q3`'s recommendation, both count only programs with no year whose
  end is today or later.
  Also delete the dead copy in `checkin-app/src/app/programs/page.tsx`: the
  `(Ongoing)` and `Start Date TBD` fallbacks can no longer render.
- **Rules:** applies the needs-a-person line; then the Last step below.
- **Tests:** unit for the count, the badge and the nav pill.
- **Migration safety:** none.
- **Blocked on:** PR 4 deployed, or the board sees every program flagged; scope
  from `PMY-Q3`.

### PR 6, only if `PMY-Q3` says every program [mig + app]

Once the PR 5 count reads zero in production, which is an operations event, not a
deploy: `SET NOT NULL` on the column, and remove the end-date fallback from
`programCoverageDate`. Every writer must already write the column, so check the
seed helpers and any test factory that inserts programs directly.

## Ordering against other work

**Settlement year (#1655, `1655_MEMBERSHIP_YEAR_DECLARED.md`).** Neither blocks the
other. Both use `appliesToYear` and the same helpers in
`checkin-app/src/lib/programYear.ts`; whichever lands first writes them. Its owed
decision (which year a new joiner's checkout sells inside the renewal window)
does not touch this plan.

**Program restructure (`docs/designs/PROGRAM_INSTANCE_RESTRUCTURE.md`).** Not
blocking. The year moves to the run with the dates. If its run-columns migration
lands before PR 1, PR 1 adds the column to both tables; if after, that migration
adds it. Its re-sync and dual-write carry it, and its read phase moves the four
`programCoverageDate` callers to the run. Its column table gains one row for
`appliesToYear`, home: instance, whichever lands second.

**Unified signup (#1370).** Its pricing has no coverage term yet. It should land
after PR 2 and read the program's `appliesToYear`; once #1655 is in too, the
member test is "a settlement whose `appliesToYear` equals the program's".

## Destination: `docs/rules/programs.md`

**Delete** the block under Pricing beginning "**Candidate, not settled — for owner
ratification.** Member pricing requires the membership to cover the program's end
date", and the clause "What 'covers the program' means rests on the candidate
below, which is not settled." in the member-discount-code line. (PR 2.)

**Insert** under Pricing (PR 2):

```markdown
- Member pricing requires the household's dues to cover the membership year the
  program runs in, not the program's own dates. A program with no stated year is
  judged against its end date.  [Decision]
```

**Insert** under Pricing (PR 3, wording of the last clause per `PMY-Q1`):

```markdown
- A program runs in one membership year and states which. The statement is
  derived when the program's dates fall inside one membership year, and recorded
  from the budget approval when they do not. Only the board and sysadmins record
  or change it.  [Decision]

- A program cannot be created or re-dated before the membership-year boundary is
  set. There is no membership year to state until there is a boundary to state
  it against.  [Decision — *Principle: where finishing an operation would take
  inventing a fact, refuse to finish it*]
```

**Insert** under Assumptions (PR 3):

```markdown
- A program running across the membership-year boundary is assigned to a year
  when the board approves its budget. The person recording it copies that
  decision; nothing in the app decides it. This holds while programs are
  budgeted before they are created.

- The membership-year boundary is set once and does not move. Were it to move,
  every household's renewal date, every background check's validity window and
  every agreement's cycle would need reconciling before program years mattered;
  the app rebuilds none of it. This holds while changing the boundary stays a
  deliberate organisation-wide act.
```

**Insert** under Pricing (PR 5, scope per `PMY-Q3`):

```markdown
- A program that has not ended and needs a stated year it does not have says so
  where programs are managed, and counts toward the board's to-do list, until
  somebody records it.  [Decision]
```

Nothing about the column, the derivation, the fill or the write-path checks goes
into the rules file. The date and age rules are already in it.

## Last step

In PR 5: confirm every block above is in `docs/rules/programs.md`, then delete
both files in this directory.
