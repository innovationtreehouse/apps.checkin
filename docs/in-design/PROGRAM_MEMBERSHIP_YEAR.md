# Programs state the membership year they run in

## Problem

A program that runs across the membership-year boundary belongs to one
membership year, and the app does not know which. The board decides it when it
approves the program's budget; nothing records that answer, so the app guesses
from the program's dates.

Its guess is always "the later year". To get the member price, a household's
dues must reach the program's last day, and for a program that ends after the
boundary that means dues for the coming year. That is right when the board put
the program in the coming year. When the board put it in the year now running, a
household that has paid for exactly the year the program is *for* is charged the
outside price, gets no announcement of the program, and is shown no member
pricing.

A second cost sits behind the first: other work needs the answer as a stored
fact. Unified signup prices a combined checkout and should ask "does this
household's year match the program's year" rather than repeat the date
arithmetic. The work to record which year a membership payment bought needs the
same thing on the program side to compare against. Neither can be built cleanly
on a guess.

Every program now has a start date and an end date; the app refuses one without
both. So a program that fits inside one membership year is never in doubt. The
problem is only the program that crosses the boundary, and the fact that the
year, even when obvious, is nowhere written down.

## Objective

Every program states the membership year it runs in. Member pricing, the member
discount check and the new-program announcement judge a household's coverage
against that year, not against the program's dates.

## Executive summary

**For the person creating or editing a program**, nothing changes when the dates
fall inside one membership year: the app fills the year in and never shows it.
When the dates cross the boundary, the form asks which year the program counts
in, and the program cannot be saved until somebody answers. The answer is copied
from the budget approval, not decided on the form.

**For a family**, nothing changes for any program inside one membership year.
That is exact, not approximate; [What coverage becomes](#what-coverage-becomes)
gives the argument. A program crossing the boundary and stated as being in the
later year also behaves exactly as today. The one change is a crossing program
stated as being in the earlier year: a household paid up for that year now gets
the member price and the announcement.

**For the board**, three things. A program cannot be created until the
membership-year boundary is set, because there is no year to state without it.
Existing programs that cross the boundary cannot be filled in by the app; they
show a red badge and count toward the board's nav until somebody states their
year, and until then they read exactly as they do today. And stating or changing
a program's year is a pricing act, so who may do it is the board's call (see
`PMY-Q1` in the migration file).

**The cost** is one nullable integer column, a derivation and a check on the two
program write routes, a select on the two program forms, one changed horizon
function, a one-time fill of existing rows, and a badge with its nav count.

**Deliberately not in scope:** who counts as a member, what dues settle, when a
membership covers what, how long a program runs, and the age rules. This design
changes only which date a program's member pricing is judged against.

## Rules this relies on and intends to change

Relied on, from `docs/rules/membership.md`: the membership year runs 1 September
to 31 August, one boundary for the whole organisation (Policy). And the renewal
rule that coverage is what was bought: a household settled for the year in
effect is covered to the boundary that closes it, otherwise only to the boundary
that opened it.

Relied on, from `docs/rules/programs.md`: a program has both a start and an end
date, and age eligibility is measured at the start. Only the board and sysadmins
set a program's price.

Changed, in `docs/rules/programs.md`: the candidate block under Pricing that
judges member pricing against the program's end date. This design replaces that
inference, so the block is superseded rather than ratified.

Relied on, from `docs/rules/principles.md`: *where finishing an operation would
take inventing a fact, refuse to finish it.* It decides three things the same
way: the fill of existing rows guesses no year, a crossing program is not saved
without one, and no program is created before the boundary that names its year
exists. And *missing or ambiguous data resolves to the more restrictive reading*,
which is why a program with no stated year keeps today's reading: for a crossing
program, judging against the end date is the stricter of the two answers.

## Naming a membership year

The board configures the boundary as a month and day; the year on the stored
date is not read. A membership year is the span from one occurrence of the
boundary to the next. Because it spans two calendar years, its **name is the
spanning form, `2026-2027`**, with both years in full. Under a 1 September
boundary, membership year `2026-2027` runs from 1 September 2026 to 31 August
2027. It is the label the app already shows for the membership year in effect
(`membershipYearCycle(...).label` in `checkin-app/src/lib/membership/renewal.ts`)
and the form `membershipYearCycleForLabel` parses back.

**It is stored as one integer: the year the boundary opens in (`2026`).** The
closing year is always one more, so the label is formatted, never stored. An
integer rather than a date is what keeps the value honest: a stored date would be
a second copy of a board setting, wrong from the moment the setting changed. The
integer re-resolves against the current boundary every time it is read.

The year a membership payment buys (`1655_MEMBERSHIP_YEAR_DECLARED.md`) uses the
same integer, under the same field name, `appliesToYear`, and renders through the
same label. A family therefore reads one `2026-2027` for a program's year and for
the year their own dues cover, and the two can be compared as plain integers.

Two small pure helpers carry the arithmetic: which membership year a date falls
in, and the label for a year. They live in the prisma-free
`checkin-app/src/lib/programYear.ts`, beside `nextBoundary`, because the program
forms need them in the browser and `renewal.ts` imports prisma. Whichever of this
work and the settlement-year work lands first writes them; the other reuses them.

## What a program declares

One nullable column on `Program`: `appliesToYear`, the opening-year integer,
tier `@sensitivity:public` like the dates it summarises.

**Which years a program's dates touch.** The start date falls in the year whose
opening boundary is on or before it. The end date is read the same way, except
that an end date *on* the boundary counts in the year that boundary closes,
because coverage of a year reaches its closing boundary inclusively. A program
running from 1 June to 1 September therefore fits in one year; one running to 2
September crosses. A one-day program on the boundary day itself is in the year
it starts.

The value is **derived on write** when the dates decide it and **required from
the caller** when they do not:

| Dates | `appliesToYear` |
|---|---|
| Start and end in the same membership year | derived, silently; anything supplied is overwritten |
| Start and end in different membership years | **must be supplied**, and must be one of the two years the dates touch; rejected otherwise |
| No boundary configured | the write is refused; see below |

A program spanning more than two membership years touches more than two; it may
be stated as any year it touches. No such program exists, and nothing more is
built for it.

The person filling the field is **recording an answer, not choosing one**. A
crossing program is put in a year when the board approves its budget, so by the
time somebody opens the form the year is already decided and written down
elsewhere. That is why nothing is pre-selected: a default would be the form
supplying an answer the budget already gave, and the two would agree until the
day they did not.

**Editing dates re-derives.** If the new dates decide the year, the derived value
wins. If they still cross the boundary and the stated year is one of the years
they touch, it stands; nudging a date inside the same pair of years is no reason
to ask again. Otherwise the edit is rejected until a year is supplied.

**Who may state it** is open as `PMY-Q1`. A program leader can edit dates today,
but the stated year decides who gets the member price, and only the board and
sysadmins set price. The recommendation is that only the board and sysadmins
supply or change a stated year, and that a leader's date edit needing a new
statement is refused with a message to ask the board. A leader's edit inside one
year still re-derives silently; derivation is not a choice.

**Changing it after money has moved** is open as `PMY-Q2`, because the member
discount check runs again when an order arrives and when the board reconciles,
and judges against the year as it stands then.

### The boundary is what a year is named against

An integer names a membership year only because the boundary says where years
start and stop.

**With no boundary configured, a program cannot be created or re-dated.** The year
cannot be derived, because the same date sits in different years depending on
where the boundary falls: 15 October is in the year opening in 2026 under a
September boundary and the year opening in 2025 under a November one. Nor can it
be asked for, because a typed year would name a span nobody has defined. The
write is refused with a message naming the missing setting.

That is the right failure. The same setting decides when renewals open, how long
a background check stays valid, which cycle an agreement belongs to, and what the
compliance and intake surfaces count, and none of them work until it is set. The
board's nav already shows a red pill while it is unset, so somebody stopped here
is stopped by a gap they are already being told about.

**The boundary is assumed not to move.** It is set once, and changing it
afterwards sits behind a deliberate confirm on the settings page because it
shifts every household's renewal cycle. If it ever did move, program years would
be one line in a long reconcile: renewal dates, background-check validity and
agreement cycles would all need revisiting first, and each is a bigger question
than which year a program counts in. Rebuilding program years does not belong to
this design.

## What coverage becomes

The date a program's member pricing is judged against stops being *the program's
end date* and becomes *the boundary that closes the program's stated year*. Where
no year is stated, the end date is still used, which is what lets this land
before every existing program has a year.

The claim that nothing moves for a program inside one year needs the argument,
because it keeps the blast radius to the one case in
[The changes](#the-changes).

A household's coverage always ends on a boundary date: the boundary that closes
the year in effect for a household that settled for it, otherwise the one that
opened it. Take a program inside membership year Y. Judged the old way, coverage
must reach the program's end, a date inside Y or on its closing boundary. Judged
the new way, it must reach the boundary that closes Y. The earliest boundary date
on or after any date in Y is the boundary that closes Y, so a coverage horizon
reaches one exactly when it reaches the other. Both rules admit the same
households.

The same argument covers a crossing program stated as being in the later year:
its end falls inside that later year, so the old rule already needed coverage to
the boundary that closes it.

With no boundary configured, the horizon cannot be computed and coverage passes,
as it does today. Only a legacy program or a boundary cleared afterwards can reach
that path, and the guard is kept because a null guard on a money path costs less
than proving it unreachable.

## The changes

**A crossing program stated as being in the earlier year** is priced against that
year. A household covered to the boundary that closes it now gets the member
price, the member discount code and the announcement, for a program that runs
past it.

That is a widening, and neither an accident nor a new power. The year a crossing
program belongs to is settled when the board approves its budget, and that
approval already carries what the program collects. The app stops guessing at an
answer the board had already given.

**A program cannot be created, or re-dated, before the boundary is set**, where
today it can.

**A crossing program with no stated year** shows a red badge and counts toward the
board's nav, where today it looks like any other.

Nothing else changes. The catalogue, age eligibility, the recent-attachment sweep
in `checkin-app/src/lib/person/filters.ts` and the payment-plan "lands next year"
flag all read the program's dates and keep doing so; none of them asks which year
a program counts in.

## Where the year is read

The coverage horizon comes from one function, `programCoverageDate` in
`checkin-app/src/lib/orgMembership.ts`, and four places call it. All four change
together, which is the point of sharing it:

- the member discount code minted at checkout:
  `checkin-app/src/app/api/programs/[id]/discount-code/route.ts`, the money path;
- the member-code entitlement check that runs when an order arrives and when the
  board reconciles: `unentitledMemberCodeUse` in
  `checkin-app/src/lib/programs/memberDiscountCode.ts`;
- the program detail response, which tells the page whether to show member
  pricing: `GET` in `checkin-app/src/app/api/programs/[id]/route.ts`;
- the new-program announcement, whose audience is members whose coverage reaches
  the program: `notifyNewProgramAnnounced` in `checkin-app/src/lib/notifications.ts`.

The announcement moving with the other three is deliberate. Its audience is the
households that can buy at the member price, so a program stated as being in the
earlier year should reach the households covered for that year.

Two of these read the column through an explicit select, and both fail silently
if it is left out. The detail route rebuilds its argument from the JSON body its
registry handler just produced, so the column must be in that handler's select;
the entitlement check selects only the dates. Leave the column out of either and
the code compiles, the tests pass, and that reader takes the no-year path for
ever. The discount-code route loads the whole row, and the announcement receives
the whole row from the edit route.

## Interface

The create form (`checkin-app/src/app/program-ops/new/page.tsx`) and the program
settings form (`checkin-app/src/app/program-ops/programs/[id]/page.tsx`) gain the
year field. It appears only when the dates cross the boundary: a plain select of
the years the dates touch, each in the `2026-2027` form, with nothing chosen.
When the dates decide the year, the field is absent; not disabled, not shown
filled in, absent.

Its label points at the budget approval, so the person filling it knows they are
looking something up. Where `PMY-Q1` keeps the field to the board and sysadmins,
a leader sees the stated year read-only and, if their date edit would need a new
one, the message to ask the board.

### Programs that need a person

A crossing program with no stated year cannot be filled in by the app. Nobody but
a person knows the answer, so these carry a **red badge in the program-ops list
and on the program's own page**, the same treatment and place as a program priced
with no checkout variant, with a tooltip saying what is missing and that opening
the program fixes it. They also **count toward the board's nav**, next to the
broken-checkout count in `checkin-app/src/lib/nav/todoCounts.ts`. The count is
what matters: a badge is seen by somebody already on the programs list; the count
is what sends them there.

The predicate is a single null check, so it needs no shared predicate-and-filter
pair; the count and the badge both read `appliesToYear` being empty.

Which programs count is open as `PMY-Q3`: every program with no stated year, or
only those that have not yet ended. The recommendation is the second. An ended
program's year is read again only if one of its old orders is reconciled, and the
end-date reading it falls back to is the stricter one.

## Where the column lives after the program restructure

The year belongs with the dates, because it summarises them. The program
restructure (`docs/designs/PROGRAM_INSTANCE_RESTRUCTURE.md`) moves the dates from
`Program` to `ProgramInstance`, one row per run, so `appliesToYear` moves with
them: a definition such as "Woodworking 101" has no year, and each run states its
own.

Until that restructure's later phases, a program and its run are one-to-one and
the column lives on `Program`, where every reader looks today. It survives the
restructure the same way the dates do: its phase that adds the run columns adds
`appliesToYear` too, its re-sync copies it, its dual-write keeps it in step, and
its read phase points `programCoverageDate`'s four callers at the run. Whichever
of the two lands second carries the column across; the restructure's column table
gains one row either way.

## Tests

The horizon function is pure apart from reading the boundary, and carries most of
the rule, so it is tested against real coverage horizons:

- a program inside one year gives the same admit or refuse answer as the end-date
  rule, for a household covered to each of the two boundaries it can be covered
  to; this is the equivalence argument above as an assertion;
- a crossing program stated as the earlier year admits a household covered only
  to that year's closing boundary; stated as the later year, refuses it;
- a program with no stated year is judged against its end date;
- no boundary gives no horizon, and coverage passes.

The year helper is tested at the edges: a start on the boundary day is in the new
year, an end on the boundary day is in the old one, and an end one day later
crosses.

Above that, the ones a pure function cannot cover:

- each write route derives the year, rejects a crossing program with no year or
  with a year its dates do not touch, keeps a still-valid stated year across a
  date nudge, and refuses when no boundary is configured;
- the discount-code route and the entitlement check, for a crossing program
  stated as the earlier year, because the function being right does not prove the
  column reached the select;
- the fill of existing rows, run twice against a real database: it fills what the
  dates decide, leaves crossing programs empty, and changes nothing the second
  time.

## Alternatives considered

**Store the coverage-through date on the program.** Simpler to read, and wrong
the first time the board moves the boundary: every stored date becomes a stale
copy of a setting, with nothing to notice the drift. The integer re-resolves.

**Model membership years as rows.** Nothing else needs to hang off a membership
year, and the boundary defines them completely. A table would be a second source
of truth for what two integers describe.

**Ask for the year on every program, derived or not.** Makes the common case
worse, a field on every program restating what its dates already say, to buy
uniformity in the column. Where the dates decide the year there is one answer,
so deriving it guesses nothing.

**Keep inferring, from the start date instead of the end.** Removes the ambiguity
by decree and gets the crossing case wrong in whichever direction the board did
not want. The ambiguity is real; the fix is to ask.

**Let a program be created with no boundary, and fill its year in later.** Buys
the ability to create programs while renewals, background-check validity,
agreements and intake are all inert anyway, and pays for it with an empty value
that means something, a second path through the horizon, a sweep to fill values
later, and a class of program that reads differently until somebody notices.
Refusing costs one error message naming the setting.

## Appendix: provenance

Issue [#1484](https://github.com/innovationtreehouse/checkin/issues/1484)
(declare the membership year). It was designed together with
[#1441](https://github.com/innovationtreehouse/checkin/issues/1441) (a program
must have a start and a bounded end); that half has shipped, and every program
now carries both dates.

Shares its representation with
[#1655](https://github.com/innovationtreehouse/checkin/issues/1655) (the year a
membership payment buys). Consumed by
[#1370](https://github.com/innovationtreehouse/checkin/pull/1370) (unified
signup), whose pricing should read the stated year rather than work out coverage
inside the combined checkout.
