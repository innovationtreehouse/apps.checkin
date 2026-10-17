# Cutover: programs state the membership year they run in

Everything here expires when the change has run. The design is in
`PROGRAM_MEMBERSHIP_YEAR.md`.

## Where it stands

Four pull requests finish this; none has started. The date half of the original
design has shipped: every program has a start and an end date, the create and
edit routes refuse one without both, and `programCoverageDate` returns the end
date. What remains is the stated year and everything that reads it.

The owner has answered every question. None of the four waits on the
settlement-year work (#1655) or on the program restructure, though some share
files with it (see [Ordering](#ordering-against-other-work)).

## Decisions settled

- **The revenue effect of stating a crossing program as the earlier year** is
  carried by the board's budget approval, which is where the year is decided. It
  is not a new discretionary power.
- **A boundary that moves** is out of scope, as an assumption.
- **No program is created or re-dated before the boundary is set.**
- **The field is `appliesToYear`**, the opening-year integer, shared with the
  settlement-year work.
- **This design and `1655_MEMBERSHIP_YEAR_DECLARED.md` describe one
  membership-year rule** and are planned together (`MY-0` there).

## Owner answers

Stable IDs; a resolved question is marked in place, never renumbered.

- **`PMY-Q1` (resolved): Who may state or change a program's year?** Only the
  Board, as part of approving the program's budget; not sysadmins. A write by
  anyone else that would need a stated year is refused with "ask the Board".
- **`PMY-Q2` (resolved): Can the stated year change once someone has paid?** Yes.
  The Board settles any resulting price difference with the families by hand. The
  form warns before saving a changed year on a program with paid places, naming
  how many. Nothing new is built to list them: an order judged after the change
  that fails the member-price check already reaches the Board as an unauthorised
  discount.
- **`PMY-Q3` (resolved): Which programs must have a stated year?** Only programs
  that cross a membership-year boundary; every other program's year comes from its
  dates. Existing programs are settled by `PMY-Q4`.
- **`PMY-Q4` (resolved): What year does an existing program get?** One fixed rule,
  applied to every program, crossing or not: one that ended on or before 31 July
  2026 gets `2025` (`2025-2026`); every other program gets `2026` (`2026-2027`).
  Every row is then filled, so the column becomes required in the same PR and no
  badge or to-do count is built: nothing can be left without a year.

## Build plan

Each PR is shippable on its own and green on its own. No step adds a route, so no
registry or security-boundary PR is needed; the regenerated classifications in
PR 1 are a pure addition, which the boundary-isolation check accepts alongside
schema changes.

Order: **1 → 2 → 3 → 4.** PR 2 goes before PR 3 because it is unblocked and
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
  whole drain window. No index: nothing filters on it.
- **Blocked on:** nothing. If the restructure's run-columns migration has landed
  first, add the column to `ProgramInstance` in the same migration and to its
  re-sync.

### PR 2: coverage reads the stated year [app]

- **Files:** `checkin-app/src/lib/orgMembership.ts`: `programCoverageDate` takes
  `{ endAt, appliesToYear }`, reads the boundary, and returns the boundary that
  closes the stated year, or `endAt` when no year is stated (until PR 4) or no
  boundary is set. It becomes async. Its four callers:
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
  - `checkin-app/src/lib/programYear.ts`: the shared helpers `membershipYearOf`
    (the year a date falls in) and `membershipYearLabel` (`2026-2027`), unless
    #1655's PR 7 has already written them; then this plan's own wrappers, the
    end-date rule from the design and the years a pair of dates touches.
  - `checkin-app/src/app/api/programs/route.ts` `POST` and `updateProgram` in
    `checkin-app/src/lib/programs/update.ts`, which the `PATCH` delegates to:
    refuse with a message naming the setting when no boundary is configured;
    derive the year when the dates decide it; otherwise require one of the years
    the dates touch, keeping a still-valid stated year across a date edit.
    Supplying or changing a stated year needs `actor.isBoardMember`, the check the
    off-sale date already uses there (`PMY-Q1`). `POST` admits sysadmins too, so a
    sysadmin creating a crossing program is refused with "ask the Board". A change
    after payment is not refused (`PMY-Q2`).
  - `checkin-app/src/app/program-ops/new/page.tsx` and
    `checkin-app/src/app/program-ops/programs/[id]/page.tsx`: the conditional
    select, labelled to point at the budget approval, editable by a Board member
    and read-only for everyone else. On the settings form, changing a stated year
    on a program with paid places (participants with status `ACTIVE`, which the
    page already loads) asks for confirmation naming their number. The settings
    form's `startAt`/`endAt` types are still `string | null`; tighten them while
    there.
  - Delete the dead copy in `checkin-app/src/app/programs/page.tsx`: the
    `(Ongoing)` and `Start Date TBD` fallbacks can no longer render.
  - Seed: `checkin-app/prisma/seed.ts` writes the `BoardSettings` boundary at the
    policy value (1 September), and both `prisma.program.create` calls in
    `checkin-app/src/lib/dev/seed-helpers.ts` derive the year; PR 4's constraint
    fails any program created without one. Without the
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
- **Blocked on:** PR 1.

### PR 4: fill existing programs and require the year [mig + app]

- **Files:**
  - One migration, wrapped in `BEGIN;`/`COMMIT;` with the fill marked for
    extraction, as the restructure's first migration does:

    ```sql
    UPDATE "Program" SET "appliesToYear" =
      CASE WHEN "endAt" <= DATE '2026-07-31' THEN 2025 ELSE 2026 END
      WHERE "appliesToYear" IS NULL;
    ALTER TABLE "Program" ALTER COLUMN "appliesToYear" SET NOT NULL;
    ```

    The rule is the owner's (`PMY-Q4`) and applies to every program, crossing or
    not; it reads no boundary.
  - `checkin-app/prisma/schema.prisma`: `appliesToYear Int`.
  - `programCoverageDate` in `checkin-app/src/lib/orgMembership.ts` loses the
    no-year fallback, and its parameter type makes the year required, so a reader
    whose select leaves it out stops compiling. Drop the no-year test case.
  - Any test factory that inserts programs directly writes a year; grep all three
    test roots for `program.create`.
- **Tests:** an integration test (heavy) that extracts the fill and checks a
  program ending 31 July 2026 gets `2025`, one ending 1 August 2026 gets `2026`, a
  crossing program and a later program get `2026`, and a stated year is left alone;
  then full `npm run test:ci` and the integration suites for the four
  `programCoverageDate` callers.
- **Migration safety:** the fill runs before `SET NOT NULL` in one transaction, so
  the constraint cannot meet an empty row. During the drain the old release is
  PR 3's, which writes a year on every create, so it is safe against the
  constraint. This must therefore deploy in a release after PR 3 is deployed, never
  in the same release. Before merging, count programs created since PR 3 deployed
  with no year in production; it must be zero (anything else means a writer the
  plan missed).
- **Rules:** the Last step below.
- **Blocked on:** PR 3 deployed.

## Ordering against other work

**Settlement year (#1655, `1655_MEMBERSHIP_YEAR_DECLARED.md`).** Neither blocks the
other, but they share files, and a shared file is never edited by both at once:

| Shared | This plan | #1655 plan | Rule |
|---|---|---|---|
| `schema.prisma`, a new migration, `classifications.ts` | PR 1 | PR 1 | land one, rebase and regenerate the other |
| `programYear.ts` helpers | PR 3 | PR 7 | the first of the two to start writes `membershipYearOf` and `membershipYearLabel`; the other reuses them |
| `orgMembership.ts` and the program-pricing integration suites | PRs 2, 4 | PR 4 | serialize |

Member pricing needs nothing from #1655 beyond its PR 4: the horizon this plan
compares against comes from `membershipValidThrough`, which that PR moves to the
recorded year.

**Program restructure (`docs/designs/PROGRAM_INSTANCE_RESTRUCTURE.md`).** Not
blocking. The year moves to the run with the dates. If its run-columns migration
lands before PR 1, PR 1 adds the column to both tables; if after, that migration
adds it. Its re-sync and dual-write carry it, and its read phase moves the four
`programCoverageDate` callers to the run. Its column table gains one row for
`appliesToYear`, home: instance, whichever lands second.

**Unified signup (#1370).** Its pricing has no coverage term yet. It should land
after PR 2 and use the same horizon comparison, the household's
`membershipValidThrough` against `programCoverageDate`. It must not test that a
settlement's year equals the program's: a family that joined inside the renewal
window bought the coming year and is covered through the year in progress too, so
an equality test would refuse it the member price on a summer program.

## Destination: `docs/rules/programs.md`

**Delete** the block under Pricing beginning "**Candidate, not settled — for owner
ratification.** Member pricing requires the membership to cover the program's end
date", and the clause "What 'covers the program' means rests on the candidate
below, which is not settled." in the member-discount-code line. (PR 2.)

**Insert** under Pricing (PR 2):

```markdown
- Member pricing requires the household's dues to cover the membership year the
  program runs in, not the program's own dates.  [Decision]
```

**Insert** under Pricing (PR 3):

```markdown
- A program runs in one membership year and states which. The statement is
  derived when the program's dates fall inside one membership year, and recorded
  from the Board's budget approval when they do not. Only the Board records or
  changes it.  [Decision]

- The Board may change a program's stated year after places are paid. Nothing
  already paid is repriced; the Board settles any difference with those families.
  [Decision — *Principle: people decide about people*]

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

Nothing about the column, the derivation, the fill or the write-path checks goes
into the rules file. The date and age rules are already in it.

## Last step

In PR 4: confirm every block above is in `docs/rules/programs.md`, then delete
both files in this directory.
