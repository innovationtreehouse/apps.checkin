# Program dates and the membership year they run in

## Problem

A program can be created with no dates at all. Nothing requires a start and
nothing requires an end, and three rules quietly change meaning when they are
missing.

**What it costs a family.** A household's membership covers one membership year,
ending on the same date for everybody, and a program's member price should apply
only when that coverage reaches the program. The app works out what "reaches the
program" means by reading the program's own dates. Give it none and it has
nothing to compare, and nothing to compare is read as covered — so every
household gets the member price, including one whose dues lapsed.

**What it costs the catalogue.** A program with no end date is read as running
forever. It never leaves the list of what is currently on, so a class that
finished in the spring is still advertised in the autumn with nobody having done
anything wrong.

**What it costs eligibility.** An age limit is judged as of the program's start.
With no start, it is judged as of the moment somebody asks — so the same person
is eligible or not depending on when the page is loaded, which is the exact
thing an age rule exists to prevent.

Then there is the case where the dates are present and still do not answer. A
program running across the membership-year boundary belongs to the year it starts
in or the year it ends in, and nothing in the dates distinguishes them — only the
person who scheduled it knows which year it counts against. Read one way, a
household that has just joined pays the member price for a program running mostly
past the point their dues stop covering. Read the other, a household that has
paid for the year the program is *for* pays the outside price.

## Objective

Every program has a start, a bounded run, and a stated membership year. Pricing,
the catalogue, announcements and eligibility read those instead of inferring them
from what happens to be filled in.

## Executive summary

**For the person creating a program**, a start date becomes required. An end date
does not: leaving it off now means "runs to the end of its membership year"
rather than "runs forever". They are asked which membership year the program
counts in only when the dates cross the boundary and cannot decide it; otherwise
it is filled in and never shown.

**For a member**, nothing changes for any program that fits inside one membership
year — not "roughly nothing", exactly nothing, for the reason in
[What coverage becomes](#what-coverage-becomes). What changes is listed
case by case in [The changes](#the-changes), and the list is complete.

**For the board**, two things. Existing programs missing a start date, or
straddling the boundary, cannot be fixed by the app — nobody but a person knows
the answer, so they are reported and set by hand, and until then they read exactly
as they do today. And the membership-year boundary becomes a precondition for
creating a program at all, rather than a setting whose absence quietly changes
what every program's dates mean.

**The cost** is one nullable column, a required field on one form, a derivation
on write, one changed horizon function, one changed catalogue filter, and that
by-hand pass.

**Deliberately not in scope:** who counts as a member, what dues settle, when a
membership covers what, and the enrollment age bands themselves. This design
changes only which dates those rules are evaluated against.

## Why this is one design and not two

The two problems look separable — "require dates" and "declare a year" — and
solving them apart produces a worse answer to both.

Requiring dates alone means requiring an *end* date, since an unbounded end is
what breaks the catalogue. But plenty of programs genuinely have no known end
when they are created, and forcing a number produces an invented one, which is
worse than an absent one because nothing downstream can tell it from a real
answer.

Declaring a year alone leaves the derivation partial: a program with no dates has
no year to derive and nothing to fall back on.

Together they close: **the declared membership year is what makes an absent end
date bounded.** An end date is optional because the year supplies one; the year
is nearly always derivable because a start is required. Neither half stands up
without the other.

## Rules this relies on and intends to change

Relied on, from `docs/rules/membership.md`: the membership year runs 1 September
to 31 August, one boundary for every household, and it is Policy.

Changed, in `docs/rules/programs.md`: the standing candidate block under Pricing
describes coverage as judged against the program's own end date. This design
replaces the inference it describes, so that block is superseded rather than
ratified. The replacement text, and the entries the date requirements owe, are in
the migration file.

Relied on, from `docs/rules/principles.md`: *missing or ambiguous data resolves to
the more restrictive reading* — which the dateless-program pricing behaviour
violates outright, and removing it is what the principle requires rather than
merely permits. And *where finishing an operation would take inventing a fact,
refuse to finish it*, which decides two things the same way: no backfill guesses a
start date, and no program is created before the boundary that would name its
year exists.

## Naming a membership year

The board configures a boundary as a month and day; the year on the stored value
is not read. A membership year is therefore the span between one occurrence of
that boundary and the next. Because it spans two calendar years, its **name is
the spanning form, `2026-2027`** (both years in full) — the year the boundary
opens in and the year it closes in — which is what a human sees and is unambiguous
in a way a bare `2026` is not. With a 1 September boundary, membership year
`2026-2027` runs 1 September 2026 to 31 August 2027. This is the exact label the
shipped `membershipYearCycle(...).label` in
`checkin-app/src/lib/membership/renewal.ts` produces, and `membershipYearCycleForLabel`
parses back (its test rejects short forms) — so the four-digit form, not a
`2026-27` variant.

**Stored as a single integer — the opening-boundary year (`2026`).** The closing
half is always the opening half plus one, so the `2026-2027` label is formatted
from the one integer by the existing `membershipYearCycle` /
`membershipYearCycleForLabel` pair, not stored. The integer, not a date, is
the whole reason the scheme survives the board moving the boundary: a stored date
would be a second copy of a board setting, wrong from the moment the setting
changed and silently so. The integer re-resolves against the current boundary
every time it is read.

The membership year a settlement *buys* uses this identical scheme — see
`1655_MEMBERSHIP_YEAR_DECLARED.md`. Both store the opening-year integer and render
through the same shipped label helper, so a member reads the same `2026-2027` label
for a program's year and for the year their own dues cover.

## Program dates

**A start is required.** Every write path takes it: creation, and any edit that
would clear it. This is what makes age eligibility answerable — it is already
judged as of the start wherever a start exists, in both the interface and the
enrollment route, so requiring one closes the gap without touching the age rules
themselves.

The direction of that gap is worth stating rather than leaving to be discovered.
Judging age at the moment of asking rather than at the start makes a person look
*younger* than they will be for a program that has not begun, which refuses
somebody who would have qualified — annoying, and safe. It makes them look
*older* for a program already under way, which admits somebody who did not
qualify at the start. Enrollment normally happens before a program begins, so the
common case has been erring in the conservative direction. That is why this is
worth fixing properly rather than urgently.

**An end is optional and the run is bounded anyway.** Where no end date is given,
the program runs to the end of its membership year. There is no third state: no
program runs indefinitely, and none is missing an answer to "when is this over".

That resolves the catalogue. "Currently running" stops meaning *ends in the
future, or has no end at all* and starts meaning *its effective end is in the
future* — so an undated program leaves the list when its year closes rather than
being advertised forever.

**Existing programs with no start** cannot be given one by a migration. A person
sets them or they keep reading as they do today; the backfill reports them and
does not guess.

## What a program declares

One nullable column on the program: the membership year it runs in, as that
opening-year integer (displayed as the `2026-2027` span).

The value is **derived on write** whenever the dates decide it, and **required
from the caller** when they do not:

| Dates | Declaration |
|---|---|
| Start and end inside one membership year | derived, silently |
| Start present, no end | derived from the start |
| Start and end in different membership years | **caller must supply it**; rejected otherwise |
| No dates at all | cannot occur — a start is required |
| No boundary configured | cannot occur — the program is refused; see below |

Derivation is not a default the caller can override into nonsense: a supplied
year that is neither of the two years the program's dates touch is rejected the
same way a missing one is.

The person creating the program is **recording an answer, not choosing one**. A
program that crosses the boundary is assigned to a membership year when the board
approves its budget, so by the time somebody opens the form the year is already
decided and written down elsewhere. The field asks them to transcribe it.

That is why nothing is pre-selected. A default would be the form supplying an
answer the budget already gave, and the two would agree until the day they did
not — at which point the click nobody thought about wins over the decision
somebody made.

### The boundary is what a year is named against

An integer names a membership year only because the boundary says where one
starts and stops. Two things follow.

**With no boundary configured, a program cannot be created at all.** Not derived,
because the same start date sits in different membership years depending on where
the boundary falls — 15 October is in the year that opened in 2026 under a
September boundary and the year that opened in 2025 under a November one. And not
asked for either: a year the board typed would name a span nobody has defined. The
write refuses and says which setting is missing.

That is a harder failure than today's, and it is the right one. There is no such
thing as this system running without a boundary. The same setting decides when
renewals open, how long a background check stays valid, which cycle an agreement
belongs to, and what the compliance and intake surfaces count — none of which
operate until it is set. An unconfigured boundary is not a degraded mode to carry
through the design; it is an install that has not been finished. Programs created
in that window would each be a small piece of unfinished configuration, stored,
and carried forward as a state every later reader has to handle. Refusing costs
one error message. Accommodating costs a nullable column with a meaning, a second
code path in the horizon, a sweep to fill the values in later, and a class of row
that behaves unlike every other one for as long as the table exists.

The principle is the one that governs the backfill too: where finishing an
operation would take inventing a fact, refuse to finish it. The operation stops
and says what it needs, and the person who knows supplies it.

**The boundary is assumed not to move.** It is set once, when the organisation is
configured, and changing it afterwards is gated behind a deliberate unlock
because it shifts every household's renewal cycle.

If it ever did move, program years would be one line on a long reconcile: every
household's renewal date, every background check's validity window, and every
agreement's cycle would need revisiting first, and each of those is a bigger
question than which year a program counts in. Rebuilding program years is not the
hard part of that exercise and does not belong to this design. This is an
assumption in the register's sense — stated, with the condition that keeps it
true, which is that moving the boundary is a deliberate organisation-wide act
nobody performs casually.

## What coverage becomes

The horizon a program's member pricing is judged against stops being *the
program's end date, or failing that its start* and becomes *the end of the
program's declared membership year*. Where no year is declared, the old rule
still applies, which is what makes the change safe to land before every existing
program has one.

The claim that this moves nothing for a program inside a single year deserves the
argument rather than assertion, because it is what keeps the blast radius to the
cases listed below.

A household's coverage horizon is **always a boundary date**. It is the next
boundary for a household that has not yet renewed, and the one after it for a
household already settled for the coming year; there is no third shape. Now take
a program that fits inside membership year Y. Judged the old way, coverage must
reach some date in the middle of Y. Judged the new way, it must reach the
boundary that closes Y. But the smallest boundary date that reaches any mid-year
date in Y *is* the boundary that closes Y — a household covered to the boundary
that opened Y is not covered to any date after it. Both rules therefore admit
exactly the same households.

The equivalence breaks precisely where the program does not fit inside one year,
which is the case this design exists to decide.

## The changes

**A program crossing the boundary** is priced against its declared year. Declared
to the later year, this is what happens today. Declared to the earlier year, a
household covered only to that boundary now gets the member price for a program
that runs past it.

That is a widening, and it is neither an accident nor a new power. The year a
crossing program belongs to is settled when the board approves its budget, and
that approval already carries what it means for what the program collects. What
changes here is only that the app stops guessing at an answer the board had
already given.

**A program with no dates** stops granting the member price unconditionally. Once
it declares a year, a household whose coverage does not reach that year's end
pays the outside price, like any other program.

**A program with no end date leaves the catalogue** when its membership year
closes, instead of showing as currently running forever.

**"Ongoing" stops being true.** Three surfaces render a missing end date as
"Ongoing" or "(Ongoing)". An undated program is no longer ongoing — it ends when
its year does — so the copy states that end instead.

**Age eligibility gets a fixed reference point** on every program created from
here, because every one of them has a start.

**A program cannot be created before the membership-year boundary is set**, where
today one can be, and every rule that reads its dates then answers from a setting
nobody chose.

**A program that still needs a person** — no start, or no year where one is
required — shows a red badge and counts toward the board's nav, where today it is
indistinguishable from a complete one.

## Where these are read

The coverage horizon is shared by three call sites, and all three change
together, which is the point of it being shared:

- the member discount code minted at checkout — the money path
- the program detail response, which tells the interface whether to show member
  pricing
- the new-program announcement, whose audience is members whose coverage reaches
  the program

The announcement moving with the other two is deliberate. Its audience is exactly
the households that can buy at the member price, so a program declared to the
earlier year should reach the households covered for that year.

Two of those read the column through an **explicit Prisma select**, and the
detail route rebuilds its argument from the JSON body it just produced. Leave the
column out of either select and the code compiles, the tests pass, and both
routes quietly take the no-declaration path forever. Adding it to both is part of
the change, not a follow-up.

The effective end is read by the catalogue's "currently running" filter, which is
a database query rather than a function call, so it is the one place the rule is
restated rather than shared. It has to be, and that is a reason to test it
directly.

One further place reads program dates: the sweep that decides who is recently
attached to a program (`recentProgramWhere` in `src/lib/person/filters.ts`). It
bounds attachment by the program's window, not by the declared year, so it stays
as it is. `startAt`/`endAt` are NOT NULL, so there is no null-date case.

## Interface

The create form gains a required start date. The membership-year field appears
only when the dates fail to decide the year: a plain select of the two years the
program's dates touch — each shown in the `2026-2027` span form — with nothing
chosen. When the dates decide it, the field is absent — not disabled, not
pre-filled and read-only, absent.

Where the field does appear, its label points at the budget approval rather than
asking for a judgement — the person filling it in is looking something up, and the
copy should tell them where.

Editing dates re-derives. If the new dates decide the year, the derived value
wins. If they cross the boundary and the existing declaration is one of the two
years they touch, it stands; a date nudge inside the same pair of years is not a
reason to re-ask. Otherwise the edit is rejected until a year is supplied.

### Programs that need a person

Legacy programs missing a start date or a declared year cannot be fixed by any
sweep, so they need to be visible where somebody will act on them rather than
sitting in a report nobody reopens. They carry a **red badge in the program-ops
list and on the program's own page**, exactly as a program priced with no
checkout variant does today — same treatment, same place, with a tooltip saying
what is missing and that opening the program fixes it.

That existing badge is worth copying wholesale rather than approximating, because
it is not just a badge: it is a pure predicate paired with a matching database
filter, a test asserting the two agree, and a count feeding the board's nav. The
count matters most. A badge is seen by somebody already looking at the programs
list; a nav count is what makes anybody go there, and it is what turns "these
need cleaning up eventually" into a number that visibly goes down.

The board's nav already carries a red pill while the membership-year boundary is
unset, so the refusal above is not a dead end — somebody hitting it is being
stopped by a gap the board is already being told about.

## Tests

The horizon function is pure and carries most of the rule, so it takes the real
coverage:

- a program inside one year yields the same admit/refuse decision as the old
  rule, over a household horizon at each of the two boundary shapes — the
  equivalence claim above, as an executable assertion rather than a paragraph
- a crossing program declared to the earlier year admits a household covered only
  to that boundary; declared to the later year, refuses it
- a program with no end date is judged against its year's end
- no boundary yields no horizon — reachable only by a legacy program or a
  boundary cleared after the fact, and kept because a null guard on a money path
  is cheaper than proving it unreachable

Above that, three that the pure function cannot cover:

- the discount-code route for a crossing program, because the function being
  right does not prove the column reached the select
- the catalogue's currently-running filter, because that rule lives in a query
- creating a program with no boundary configured is refused
- the needs-a-person predicate and the database filter behind its count agree, in
  the parity style the checkout-broken pair is already tested in

## Alternatives considered

**Require an end date instead of deriving one.** The direct reading of "bounded
end", and it forces whoever creates a program to invent a date they do not have.
An invented end is worse than an absent one: nothing downstream can tell it from a
real answer, and it will be wrong in the catalogue, in pricing and in the
announcement audience simultaneously.

**Let a program be created with no boundary configured, and fill its year in
later.** The accommodating option, and the expensive one. It buys the ability to
create programs during a window in which renewals, background-check validity,
agreement cycles, intake and compliance are all inert anyway — and it pays for
that with a column whose empty value means something, a second path through the
horizon function, a sweep to fill the values in when the setting arrives, and a
class of program that reads differently from every other one until somebody
notices. Refusing costs one error message naming the setting.

**Store the coverage-through date on the program.** Simpler to read and wrong the
first time the board moves the boundary: every stored date becomes a stale copy of
a setting, with nothing to detect the drift. The integer re-resolves.

**Model membership years as rows.** Nothing else needs to hang off a membership
year, and the boundary already defines them completely. A table would be a second
source of truth for a span two integers describe.

**Require the declaration on every program, derived or not.** Makes the common
case worse — a form field on every program to restate what its dates already say —
to buy uniformity in the column. The derivation is not a guess: where the dates
decide the year, there is one answer.

**Keep inferring, but from the start date only.** Removes the ambiguity by fiat
and gets the crossing case wrong in whichever direction the board did not want.
The ambiguity is real; the fix is to ask.

**Backfill a start date for existing programs** from the earliest scheduled
session, or from when the program was created. Both are plausible and neither is
the fact being asked for; a program's first session is not its start, and the row's
creation date is not either. The principle against inventing a fact applies
directly.

## Appendix: provenance

Issues [#1484](https://github.com/innovationtreehouse/checkin/issues/1484)
(declare the membership year) and
[#1441](https://github.com/innovationtreehouse/checkin/issues/1441) (a program
must have a start and a bounded end), designed as one because neither answer
stands up alone — see [Why this is one design](#why-this-is-one-design-and-not-two).

Consumed by [#1370](https://github.com/innovationtreehouse/checkin/issues/1370)
(unified signup), whose pricing should read the declared year rather than
re-deriving coverage inside the combined checkout.
