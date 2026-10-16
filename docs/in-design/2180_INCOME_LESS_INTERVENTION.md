# Income: less routine work for finance

Design for #2180. Working doc: nothing here is true yet.

## Problem

The app books each Shopify payout into QuickBooks as a deposit, split by the
QuickBooks Class each sale belongs to. Today it gets there indirectly: finance
links each store item to a budget bucket in the app, and the bucket carries the
Class. Two things push routine work back onto finance:

1. **A sale of an item nobody has assigned is booked with no Class, for
   good.** Assigning the item afterwards only affects later sales.
   The earlier ones stay unclassed unless finance moves them in
   QuickBooks by hand.
2. **One bucket without a QuickBooks Class sends the whole payout to
   finance.** The app refuses to book the payout, and finance has to book all of
   it by hand, including the sales that had nothing wrong with them.

Behind both sits the bucket itself. Not every sale is a program: a one-time
event has a Class in QuickBooks but no program or bucket in the app, so there is
nothing to link its items to.

## Objective

Each store item points straight at a QuickBooks Class, or is marked as having
none. Once finance has made that decision for an item, the app books its sales
on its own, and finance's queue holds only payouts that need a person.

## Summary

- **Finance:** picks a QuickBooks Class for each new store item, from the
  Classes in QuickBooks, or marks it as having no Class. Once per item. A payout
  held for an undecided item or a missing Class books itself as soon as the gap
  is closed.
- **Board:** no change. Sees income as today.
- **Out of scope:** where the app's booking starts and stops. That is being
  redesigned across every lane, around the books' closing date, separately.
- **Does not change:** the app still never edits or deletes anything in
  QuickBooks; every payout still matches exactly one deposit; a payout or
  deposit that changes after matching still goes back to finance. Budget
  buckets stay as they are for expenses; income stops using them.
- **Cost:** one additive column, one new reason a payout waits, one new read
  route (and its security registry entry, landed first).

## Rules this relies on or changes

Changes, in `docs/rules/revenue.md` § Income:

- "Sales are booked to the program or fund they belong to. Sales finance hasn't
  assigned are booked as general Treehouse income" becomes: each sale is booked
  to the QuickBooks Class finance chose for its item, or to no Class where
  finance chose that. A payout with a sale of an item finance has not decided on
  waits until finance does.

Relies on, unchanged: the app never changes or deletes anything already in
QuickBooks; every payout matches one deposit; a changed payout goes back to
finance; only finance settles problems. From `principles.md`: *Accountability*,
*Decisions are reversible*, *Fail closed*, *Urgency of consistency follows risk*
(a held payout is late, not lost).

## Design

### 1. Each item points at a QuickBooks Class

- Finance picks the item's Class from the active Classes read live from
  QuickBooks, or marks the item **no Class**. No Class books the sale to the
  income account without a Class, as an unassigned item does today, but only
  because finance chose it.
- The app keeps the Class's QuickBooks id on the item. It holds no copy of the
  Class list and no link to a program or bucket.
- A payout containing a sale of an undecided item does not book. It waits with a
  new reason, *needs mapping*, naming the items.
- Each run of the app retries every payout waiting for this reason. Once finance
  decides on the items, the next run books it with no further action.
- Finance can decide on an item before it ever sells: the items list already
  shows every item the store has seen.
- **Who:** only finance assigns items, as today.
- **Audit:** each assignment is written with before and after, as today. The
  hold and its release are written like any other payout state change.
- **Reversal:** finance reassigns the item. Payouts already booked stay as they
  were; later payouts follow the new decision.

This removes the need to rebook. A sale never books without a Class unless
finance chose that, so there is nothing to move afterwards.

### 2. A Class that goes away raises an alarm and holds what depends on it

- Assigning an item to a Class that is not active in QuickBooks is refused.
- Each run checks every assigned Class against QuickBooks. When a Class has been
  archived (made inactive) or removed, the app raises an alarm for finance, the
  same way it reports a cap being hit, and the items list marks every item
  pointing at that Class. The alarm fires once per Class, not once per sale,
  and does not wait for a payout to arrive.
- Nothing that depends on that Class is booked until finance cleans it up: a
  payout with a sale of such an item waits as *needs mapping*, naming the Class,
  instead of failing. Finance reactivates the Class in QuickBooks or reassigns
  the items; the next run books the payout.
- The app never moves those items elsewhere on its own: the cleanup is
  finance's decision.
- The app does not book part of a payout. A payout is one deposit, so booking
  the good lines and holding the rest would break the one-to-one match.

### States

One new reason a payout waits, alongside no deposit, ambiguous deposit,
failed create and over cap:

| Reason | Means | Clears when |
|---|---|---|
| Needs mapping | A sale's item is undecided, or its Class is no longer active in QuickBooks | Finance closes the gap; the next run books it |

A held payout is outside the match window's clock: it does not turn into "no
deposit" while it waits. If finance books it by hand instead, the run matches
that deposit, as it would any other.

### Who may act

Only finance assigns items, reads the Class list, and settles a held payout by
hand. Finance and the board can see the queue and the reasons.

### Security registry

One new route: a finance-only read of the active QuickBooks Classes (id and
name), for the item picker. Its registry entry ships first, in its own security
PR, then the route. The item-category route keeps its endpoint, role and
response type; its new field carries the same internal tier as its neighbours.

### Migration

Additive: the item assignment gains a nullable QuickBooks Class id, and its
bucket column stops being required. A row with no Class id is a decision for no
Class; no row is undecided.

Existing assignments need their bucket's Class copied onto them once; see
`2180_INCOME_LESS_INTERVENTION-migration.md`.

Old code serving during the deploy reads only the bucket column, so an item
assigned by the new code books without a Class until the drain stops running
old code. That window is minutes, and any such deposit is finance's to correct.

### Tests

- Needs mapping: an undecided item holds the payout; deciding releases it on the
  next run; it does not become "no deposit" while held.
- No Class: an item marked no Class books without a Class and is not held.
- Class gap: assigning to an inactive Class is refused; a Class made inactive
  raises one alarm and marks its items before any payout arrives, holds a payout
  with those sales, and reactivating it or reassigning the items releases it.

## Open questions for the owner

- **Q1.** Withdrawn: the owner ruled out a takeover date; where booking starts
  is designed separately.
- **Q2.** Resolved: hold the payout. Late books are accepted to cut finance's
  work, as receipts already do (owner, 2026-10-16).
- **Q3.** Resolved: a held payout never books itself without a Class; it waits
  until finance fixes it (owner, 2026-10-16).
- **Q4.** Resolved: items store the QuickBooks Class id directly (owner,
  2026-10-16).
- **Q5.** Resolved: an archived Class raises an alarm in the app naming what
  points at it, and nothing that depends on it is booked until finance cleans it
  up (owner, 2026-10-16).
- **Q6.** Rebooking sales already booked without a Class before this ships:
  out of scope (proposed), or a one-off correction finance does in QuickBooks?
- **Q7.** Should the app accept an assignment while it cannot reach QuickBooks
  to check the Class, or refuse? Proposed: refuse; the payout check catches a
  bad Class anyway.

## Alternatives considered

- **Rebook when an item is assigned later.** The app would have to change or
  reverse a deposit already in QuickBooks, which the register forbids. A
  separate correcting journal entry is possible without editing anything, but
  adds a second kind of QuickBooks write and a reversal story for it. Holding
  until mapped avoids needing either.
- **Book the classed lines, hold the rest.** Splits one payout across two
  deposits and breaks the one-payout, one-deposit match.
- **Default an unclassed line to no Class.** Silently books a sale away from
  the Class it belongs to.
- **Keep the bucket, require it to have a Class.** Fixes the Class gap but
  keeps the indirection, and still leaves no way to book a one-time event's
  sales, which has a Class but no bucket.
