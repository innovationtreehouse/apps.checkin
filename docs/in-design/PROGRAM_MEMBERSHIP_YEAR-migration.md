# Cutover: program dates and the membership year they run in

Everything here expires when the change has run. The design is in
`PROGRAM_MEMBERSHIP_YEAR.md`.

## Decisions owed before building

None. The three that were open are settled, and the answers are folded into the
design:

- **The revenue effect of declaring a crossing program to the earlier year** is
  carried by the board's budget approval, which is where the year is decided.
  Not a new discretionary power.
- **Cleaning up legacy programs** is surfaced as a red badge and a nav count in
  the existing checkout-broken style, rather than a report. It is a number that
  visibly goes down.
- **A boundary that moves** is out of scope, as an assumption. Far more than
  program years would need reconciling first.

Still unknown, and only production can say: **how many** legacy programs need a
person. Step 6 counts them.

## Sequence

**Expand only.** A nullable integer column added to `Program`, tier
`@sensitivity:public`. `startAt` stays nullable in the schema — the requirement is
enforced on write, not by the column, because legacy rows have none and a NOT NULL
would need a value nobody can supply. Old code ignores the new column for the
whole drain window.

1. Schema: the membership-year column plus its sensitivity annotation. Regenerate
   classifications.
2. `programCoverageDate` in `checkin-app/src/lib/orgMembership.ts` takes the
   declared year and the configured boundary, and falls back to the current
   `endAt ?? startAt ?? null` when no year is declared. The fallback is what makes
   step 6 optional rather than blocking.
3. Add the column to **both** explicit selects — `PUBLIC_PROGRAM_SELECT` in
   `checkin-app/src/app/api/programs/route.ts` and the `findUnique` select in
   `checkin-app/src/app/api/programs/[id]/route.ts`. Omitting either compiles and
   passes; see the design's note on why.
4. Write paths — `POST /api/programs` and the settings `PATCH`: refuse outright
   when no boundary is configured, with an error naming the setting rather than a
   generic 400. Otherwise require a start, derive the year, and reject a crossing
   program with no year, or any supplied year outside the two the dates touch.

   The seed writes no `BoardSettings` row, so seed one with the boundary at the
   policy value — otherwise program creation fails on every dev instance and in
   the flow tests.
5. Reads:
   - the `active=true` filter in `GET /api/programs` becomes *effective end in the
     future*: an end date in the future, or no end date and a membership year that
     has not closed.
   - the three "Ongoing" / "(Ongoing)" renderings —
     `src/app/programs/page.tsx`, `src/app/programs/[id]/page.tsx`,
     `src/app/my-activities/programs/page.tsx` — state the year's end instead.
     This is a user-visible copy change; sweep the tests that assert on the string.
6. Backfill script, run once against production: derive the year for every
   program whose dates decide it, leave the rest null. It sets nothing it cannot
   derive, and it does not need to report — step 7's badge and count are the
   standing surface for what it could not do.
7. The needs-a-person surface, copied from `checkin-app/src/lib/programCheckout.ts`
   rather than approximated: a pure predicate over the fields the list response
   already carries, a matching `Prisma.ProgramWhereInput`, and the in-memory
   parity test asserting the two agree. Then
   - the red badge in `src/app/program-ops/programs/page.tsx` and on
     `src/app/program-ops/programs/[id]/page.tsx`, alongside the checkout-broken
     one;
   - the count in `src/app/api/nav/todo-counts/route.ts`, next to
     `programsMisconfig`.

   The count is the part that matters. A badge is seen by somebody already on the
   programs list; the nav count is what sends them there.
8. Interface: required start on the create form
   (`checkin-app/src/app/program-ops/new/page.tsx`) and the program settings form,
   plus the conditional membership-year select on both. Label the select so it
   reads as looking up the budget's answer, not as making a call. Render every
   year in the `2026-2027` span form via the shipped `membershipYearCycle(...).label`
   (parsed back by `membershipYearCycleForLabel`) in
   `checkin-app/src/lib/membership/renewal.ts` — the same helper the settlement-year
   work (`1655_MEMBERSHIP_YEAR_DECLARED`) uses, so a member sees one label
   everywhere. Do not add a separate formatter.

## Left alone deliberately

`recentProgramWhere` in `checkin-app/src/lib/person/filters.ts` bounds "recently
attached" by the program's own window (`endAt >= now - lookback AND startAt <= now`).
It is not reading the declared-year bound, so this change leaves it alone. `startAt`
and `endAt` are NOT NULL, so there is no null-date case to handle.

`landsNextYear` in `checkin-app/src/lib/programYear.ts` duplicates `nextBoundary`
for the browser bundle, because the canonical one pulls in prisma. The declared
year does not replace it — that flag asks whether a *request* lands next year, not
which year a program runs in. If both end up needing the same boundary math on the
client, that is a separate consolidation.

## Contract stage, later

Once no program is missing a declared year, the `endAt ?? startAt` fallback in the
horizon function is dead and comes out. Once no program is missing a start,
`startAt` can go NOT NULL. Neither is in this change: both wait on the badge count
reaching zero, which is an operations event, not a deploy.

## Ordering against other work

**#1370** (unified signup) has no coverage term in its discount maths at all. Its
pricing PR should read the declared year. Landing #1370's pricing first means
writing that term twice.

## Destination: `docs/rules/programs.md`

**Delete** the block under Pricing beginning "**Candidate, not settled — for owner
ratification.** Member pricing requires the membership to cover the program's end
date". It describes the inference this change removes; ratifying it would bless
what the change supersedes.

**Insert** under Pricing:

```markdown
- A program runs in one membership year and states which. The statement is
  derived when the program's dates fall inside a single membership year, and
  recorded by the person creating the program when they do not.  [Decision]

- Member pricing requires the household's dues to cover the membership year the
  program runs in, not the program's own dates.  [Decision]

- A program cannot be created before the membership-year boundary is set. There
  is no membership year to state until there is a boundary to state it against.
  [Decision — *Principle: where finishing an operation would take inventing a
  fact, refuse to finish it*]

- A program that needs a person — no start date, or no stated membership year
  where one is required — says so where programs are managed, until somebody
  fixes it.  [Decision]
```

**Insert** under Assumptions — both are things the app takes as true because they
are settled outside it, and both can be invalidated by a change:

```markdown
- A program running across the membership-year boundary is assigned to a year
  when the board approves its budget. The person creating it records that
  decision; nothing in the app decides it. This holds while programs are
  budgeted before they are created.

- The membership-year boundary is set once and does not move. Were it to move,
  every household's renewal date, every background check's validity window and
  every agreement's cycle would need reconciling before program years mattered;
  the app rebuilds none of it. This holds while changing the boundary stays a
  deliberate organisation-wide act.
```

**Insert** under Eligibility and enrollment, or wherever the file's date-shaped
rules sit:

```markdown
- A program has a start date, and its run is bounded. Where no end date is given
  the program runs to the end of the membership year it is in; no program runs
  indefinitely.  [Decision]

- Age eligibility is judged as of the program's start, never as of the moment
  somebody asks.  [Decision — *Principle: missing or ambiguous data resolves to
  the more restrictive reading*]
```

Nothing about derivation mechanism, the column, the backfill, or the write-path
enforcement goes into the rules file.

## Last step

Apply the blocks above, delete both files in this directory.
