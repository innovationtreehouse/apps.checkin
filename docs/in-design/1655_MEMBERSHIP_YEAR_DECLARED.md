# The membership year a settlement buys is stated, not inferred

## Problem

When a family pays for membership, the app has to know which membership year the
money bought: the year in progress, or the coming one. It never records that
answer. It works it out afterwards from the moment the family's application
finished its last step. For a renewing family that moment always falls in the
renewal window, so the guess is right. For a family joining for the first time it
can fall anywhere, and the guess can be wrong.

The case that makes it wrong is ordinary. A family joins in late June to sign a
child up for a summer program, pays that day, and their background check clears a
week later, after the renewal window has opened. The app reads the clearance date,
sees it inside the window, and concludes the family bought the coming year. It did
not; it bought the year it joined in. The renewal sweep never asks them to renew,
and they get about thirteen months of membership for one year's fee. An identical
family whose review finished a few days earlier gets the right answer. Which year a
family's money bought is being decided by how fast a reviewer worked.

The fault underneath is that a fact, *which year did this purchase cover*, is
worked out again every time it is read, from a signal that was never meant to
answer it. No timestamp answers it in every case, because the answer is not about
timing. It is a property of what was bought.

## Objective

Every membership settlement records the membership year it bought. Coverage, the
renewal sweep, the outreach audiences and the badge roster read that recorded year
instead of inferring one from when a stage completed.

## Executive summary

**For a family**, the summer-join case stops happening. A family that buys the
year in progress is asked to renew on the normal schedule; a family that buys the
coming year is not. From the day the renewal window opens, the checkout sells the
coming year to a joining family exactly as it does to a renewing one. Nothing
changes for a renewal.

**For the board**, a grant records the year it settles, and the two grant buttons
on the households page become one. Families already settled keep exactly the
coverage they have today; the board corrects any family that needs it by hand.

**For operations**, the one membership product in Shopify becomes one product
variant per membership year. Before each renewal window opens, the board enters the
coming year's variant in membership settings; an empty slot is flagged in the nav
for months beforehand, and renewals refuse to open without it.

**The cost** is one nullable integer column on the settlement record, one small
table mapping each year to its Shopify variant, a year stamped at the one place a
membership is paid, a one-time fill of existing rows, and the swap of a date test
for a year test in the readers.

**Deliberately not in scope:** what the membership year is (1 September to 31
August, one boundary for the whole organisation), what dues cost, who counts as a
member, and how long a membership covers once bought. This design changes only how
the year a settlement bought is recorded and read.

## Rules this relies on and intends to change

Relied on, from `docs/rules/membership.md`, Policy and unchanged: the membership
year runs 1 September to 31 August, one boundary for the organisation; the fee is
per family per membership year, and a family joining partway through pays for the
year it joins in.

Relied on, from `docs/rules/membership.md`, Procedure: *coverage is what was
bought*. A household settled for the membership year now in effect is covered to
the boundary that closes it; otherwise only to the boundary that opened it. This
design keeps that rule and changes how "settled for the year" is decided.

Changed, in `docs/rules/membership.md` under Renewal: the line saying that
settling inside the renewal window buys the coming year. Its intent stays: a family
that buys the coming year is covered for it and is not asked to renew it. Its
mechanism goes. "Settled inside the window" stood in for "bought the coming year";
it holds for renewals and fails for the summer join. The replacement says the
settlement states its year, and that the checkout offered from the day the window
opens sells the coming year.

Relied on, from `docs/rules/principles.md`: *missing or ambiguous data resolves to
the more restrictive reading*. A settlement with no recorded year reads as not
settled for the year in effect, which is the reading today's rule gives any row it
cannot place.

## Naming a membership year

A membership year runs from one boundary to the next, so it spans two calendar
years. Its **name is the spanning form, `2026-2027`**, both years in full. It is
the label the app already shows for the year in effect
(`membershipYearCycle(...).label` in `checkin-app/src/lib/membership/renewal.ts`).

**It is stored as one integer, the year the boundary opens in (`2026`).** The
closing year is always one more, so the label is formatted, never stored. An integer
rather than a date keeps the value honest: a stored date would be a second copy of
the board's boundary setting.

Programs use the same integer under the same field name, `appliesToYear`
(`PROGRAM_MEMBERSHIP_YEAR.md`), so a family reads one `2026-2027` for a program's
year and for the year their dues cover.

Two pure helpers carry the arithmetic: the membership year a date falls in, and the
label for a year. They go in the prisma-free `checkin-app/src/lib/programYear.ts`,
beside `nextBoundary`, because the settings page and the program forms render
labels in the browser and `renewal.ts` imports prisma.

**Two different "years" are in play, and the design needs both.** The *year in
progress* is the one the calendar is in: from 1 September 2026 to 31 August 2027
it is `2026`. The *live year* is the one coverage is judged against, and it flips
early: `membershipYearCycle` moves to the coming year on the day the renewal window
opens, two months before the boundary. So on 15 July 2027 the year in progress is
`2026` and the live year is `2027`. Outside the window the two are equal. The live
year's key is `membershipYearCycle(boundary, now).cycleStart.getUTCFullYear()`.

## What is stored

**One nullable integer on `OrgMembershipProcess`: `appliesToYear`, the membership
year that settlement bought.** It goes on the process because the process is the
record of one settlement: one payment, one grant, one renewal. A household
accumulates settlements over the years, and "which year did this buy" belongs to
each one. Stored on `OrgMembership` it would have to overwrite last year's answer.

It is set once, when the process is paid, and never changed by the app afterwards.
Background clearance, archive and every later stage leave it alone. It stays
nullable for good: a row with no year reads as not settled for the live year, which
is the correct reading for every row that has none (unpaid applications, the two
per-person process kinds, and legacy rows no rule can place). Tier
`@sensitivity:public`, like the process's other descriptive scalars.

**One table mapping each membership year to the Shopify variant that sells it.**

```
MembershipYearVariant
  membershipYear    Int     @id       // opening-year key, 2026
  shopifyVariantId  String  @unique   // @sensitivity:internal
  productUrl        String?           // @sensitivity:internal
```

One row per year, so rolling a year is adding a row and the settings schema never
grows. The variant id is unique because a variant must name exactly one year; it is
`internal` for the same reason the single variant id is today, since the browser
only ever receives the built checkout link. The table is not a second definition of
what a year is: the boundary defines the years, and a row only says which product
sells one.

## How the year is set

Every membership payment, Shopify or board, goes through one function,
`settle` in `checkin-app/src/lib/membership/payment.ts`. It already writes `paidAt`
under a row lock when a process moves out of payment. It now writes `appliesToYear`
in the same update, from a year its caller supplies. The year is never read off the
variant again afterwards.

### A Shopify payment

The paid order's membership line names a variant. Its year is that variant's row in
the table. The webhook and the reconciler already test "does this order contain the
membership product" through one helper, `membershipVariantIdSet` in
`checkin-app/src/lib/finance/reconcile/membership.ts`; that helper becomes a map
from variant id to year, and "contains the membership product" becomes "has a line
whose variant is in the map". An order whose variant is in no year's row is an order
without the membership product, and it goes where such an order goes today: nothing
is settled and the board is told.

This is the fix at its root. The family that paid in June through the `2026`
variant is stamped `2026`, whenever their background check clears.

### A board payment or grant

Four board actions pay a process without an order: the grant, the payment-plan
approval, certifying a payment, and the coming-year grant. All four call
`certifyPaymentPlan`, which calls `settle`. They stamp the live year at the moment
of certifying: the year the family's own checkout would have sold at that moment.
Off season that is the year in progress; inside the renewal window it is the coming
year.

Whether the board should instead be asked to choose, inside the window, between the
year in progress and the coming year is open as `MY-3`. The recommendation is not to
ask. The checkout a joining family uses sells the coming year from the day the
window opens; a grant that sold a different year would treat a granted family
differently from a paying one for no stated reason. And a renewal awaiting payment
can only ever buy the coming year, so the choice would exist only for a joining
family inside the window.

### The two grant buttons become one

The households page has two grant buttons, both posting to
`POST /api/membership-ops/households`:

- **Grant Membership** (`active: true`) calls `grantCurrentYear` in
  `checkin-app/src/lib/membership/grant.ts`. It pays the household's in-flight
  application, joining or renewal, through `certifyPaymentPlan`, or opens a joining
  application when there is none. It is shown only to a household that is not an
  active member.
- **Grant for coming year** (`comingYear: true`) calls `grantRenewalPayment` in
  `renewal.ts`. It pays a renewal awaiting payment, and is shown only in renewal
  season to an active household.

Both now pay a real application through the same function, so the only difference
left is which households see which button. `grantCurrentYear` already pays an
in-flight renewal; it refuses an active household only when there is nothing to pay.
One "Grant membership" button, shown whenever the household has an application
awaiting payment or is not an active member, covers both. The year it stamps is the
one above.

### The checkout link

`ensurePaymentLink` builds the link from the row for the live year, for a joining
family and a renewing one alike. A family who opens their payment page on 15 July
gets the coming year's variant, which is what the owner decided (`MY-1`). A link
fetched before the window opened and paid after it still carries the year it was
issued for, and the family is stamped with that year, because it is what they
bought.

When the live year has no row, no link is built: the family sees the same "payment
is not set up" state an unconfigured store gives today, and the gap is already on
the board's nav (below). The link is never built from another year's variant as a
substitute.

On a local or flow-test instance with the Shopify mock active, the mock variant
(`DEV_MOCK_MEMBERSHIP_VARIANT_ID`) maps to the live year. Variant ids are
per-environment configuration and the seed writes none.

## Settings, and the renewal stop

The membership settings page shows two variant slots, never more: the year in
progress (still sold to a family joining before the window opens) and the coming
year. Which two is computed from the boundary each time the page loads. Rows for
past years stay in the table, because old orders are matched against them, but
they are not shown.

The coming year's slot appears the day the previous boundary passes, about ten
months before its renewal window opens. Until it is filled it shows a red "needs
variant" badge and counts toward the board's settings-misconfiguration pill in
`checkin-app/src/lib/nav/todoCounts.ts`, which already counts a missing membership
variant.

**The renewal sweep refuses to open renewals while the coming year has no
variant.** `runRenewalSweep` already returns early when no boundary is set; it gains
a second early return of the same shape, with a reason naming the missing variant.
A renewal opened with nothing to pay through is worse than one not yet opened.

## What the readers become

Each reader asks "did this household settle for the live year". Today it asks
whether a paid process's stage was entered on or after the live year's
`settledSince`; it will ask whether the process's `appliesToYear` equals the live
year. In `checkin-app/src/lib/membership/lifecycle.ts`:

```
settledThisCycleWhere(liveYear) = {
  OR: [ { status: "ACTIVE" },
        { status: "PENDING_BG_CLEARANCE", paidAt: { not: null } } ],
  appliesToYear: liveYear,
}

handledThisCycleWhere(liveYear, windowStart) = {
  OR: [ { status: "ACTIVE", appliesToYear: liveYear },
        { status: "ARCHIVED", stageEnteredAt: { gte: windowStart } } ],
}
```

The paid-awaiting-clearance arm stays: dues paid and waiting on the background check
count as settled money. The sweep's archived arm keeps its date, because an archive
buys nothing and has no year; it records only that the board closed this cycle's
application, and opening another would pester the family.

| Reader | Today keyed on | Becomes |
|---|---|---|
| Households list and detail, `checkin-app/src/app/api/membership-ops/households/route.ts` (two sites) | `settledSince` | live year |
| `membershipValidThrough`, `checkin-app/src/lib/orgMembership.ts` (program pricing, discount code, announcements read this horizon) | `settledSince` | live year |
| Outreach audiences, `checkin-app/src/lib/outreach/recipients.ts` | `settledSince` | live year |
| Renewal sweep skip-test, `runRenewalSweep` | `windowStart` | live year, archived arm unchanged |
| Badge roster and year picklist, `checkin-app/src/app/api/people/search/route.ts` | a `stageEnteredAt` range per label | `appliesToYear` equal to the label's opening year |

`personAgreementTriggers.ts` has its own local `handledThisCycleWhere`. It shares
only the name: it decides whether an adult child's yearly agreement was already
signed this cycle, and a signature is not a settlement. It is not touched.

`stageEnteredAt` stays on the model; the lifecycle machine uses it for stage timing.
Only the coverage probes stop reading it.

### Program pricing needs nothing new

Member pricing compares a household's coverage horizon with the date a program needs
(`programCoverageDate`). Once the horizon comes from the recorded year it is right
for the summer family, and the comparison stays as it is. A test that a settlement's
year *equals* the program's year would be wrong: a family that joined inside the
window bought the coming year and is covered through the end of the year in progress
too, so it should get the member price on a summer program, and an equality test
would refuse it.

## Existing rows

Production holds real settlements, and the owner's ruling (`MY-2`) is to fix
forward. Each existing paid row gets the year today's rule already reads it as
having bought: the year whose `settledSince` window, as
`membershipYearCycleForLabel` computes it, contains the row's `stageEnteredAt`. So
no household's coverage moves when the readers switch, including the few summer
families who got the extra year. The board corrects any of those it wants to by
hand. Rows with no `stageEnteredAt`, or that today's rule cannot place, stay empty
and read as unsettled, as they do today.

## Tests

The pure pieces are tested at their edges: the year a date falls in, on and either
side of the boundary day; the live year on the day before and the day the window
opens; the variant-to-year map with the mock on and off.

Above them, the ones a pure function cannot cover:

- the webhook and the reconciler stamp the variant's year, and treat an unmapped
  variant as an order without the membership product;
- every board path stamps the live year, inside and outside the window;
- a June payment whose clearance lands after the window opens keeps its June year,
  and the sweep opens a renewal for it;
- the sweep refuses with no coming-year variant, and opens normally with one;
- the fill of existing rows, run twice against a real database, gives each row the
  year `membershipYearCycleForLabel` places it in, leaves unplaceable rows empty, and
  changes nothing the second time;
- each reader, settled and unsettled, in and out of season, against fixtures that
  carry a year.

## Alternatives considered

**Use the payment time instead of the stage time.** Rejected by the owner. It still
infers the year from a timestamp, and a grant has none, so the grant path would need
its own rule anyway.

**Keep one product and record the year from a checkout choice.** Rejected: the owner
decided there will be a variant per year, and the variant the family paid through is
evidence the store itself holds, where a choice made in the browser can drift from
what was charged.

**Store the year on the membership instead of the settlement.** A household
settles once a year; the year belongs to each settlement.

**Store a covered-through date instead of a year.** A stored date is a stale copy of
the boundary setting from the day the board moves it. The integer re-resolves.

**Correct the summer families during the fill.** Rejected by the owner (`MY-2`). It
would move live coverage for real households at cutover, from a rule that infers the
year from a different timestamp.

## Appendix: provenance

Issue [#1655](https://github.com/innovationtreehouse/checkin/issues/1655), the
`KNOWN LIMIT` recorded on `settledThisCycleWhere`. Shares its representation with
[#1484](https://github.com/innovationtreehouse/checkin/issues/1484), designed in
`PROGRAM_MEMBERSHIP_YEAR.md`. Builds on the coverage model of #1812 and the grant
path of #2003. The variant reconcilers it touches are those of #625, #1293 and #1349.
