# Income: less routine work for finance

Design for #2180. Working doc: nothing here is true yet.

## Problem

The app books each Shopify payout into QuickBooks as a deposit, split by the
budget bucket each sale belongs to. Finance links each store item to a bucket,
and each bucket carries its QuickBooks Class, one Class per bucket. Two things
push routine work back onto finance:

1. **A sale of an item nobody has assigned is booked as general income, for
   good.** Assigning the item afterwards only affects later sales. The earlier
   ones stay in general income unless finance moves them in QuickBooks by hand.
2. **One bucket without a QuickBooks Class sends the whole payout to
   finance.** The app refuses to book the payout, and finance has to book all of
   it by hand, including the sales that had nothing wrong with them.

## Objective

Each store item is assigned to a bucket, or is marked as general income. Once
finance has made that decision for an item, the app books its sales on its own,
and finance's queue holds only payouts that need a person.

## Summary

- **Finance:** assigns each new store item to a bucket or to general income,
  once per item. A one-time event gets its own bucket, like any other source of
  income with its own Class. A payout held for an undecided item or a bucket's
  missing Class books itself as soon as the gap is closed.
- **Board:** no change. Sees income as today.
- **Out of scope:** where the app's booking starts and stops. That is being
  redesigned across every lane, around the books' closing date, separately.
- **Does not change:** the app still never edits or deletes anything in
  QuickBooks; every payout still matches exactly one deposit; a payout or
  deposit that changes after matching still goes back to finance. Buckets and
  their Classes stay as finance manages them today.
- **Cost:** one relaxed column, one new reason a payout waits, one new finance
  alert. No new routes.

## Rules this relies on or changes

Changes, in `docs/rules/revenue.md` § Income:

- "Sales finance hasn't assigned are booked as general Treehouse income"
  becomes: sales are booked as general Treehouse income only where finance chose
  that for the item. A payout with a sale of an item finance has not decided on
  waits until finance does.

Relies on, unchanged: sales are booked to the bucket they belong to; the app
never changes or deletes anything already in QuickBooks; every payout matches
one deposit; a changed payout goes back to finance; only finance settles
problems. From `principles.md`: *Accountability*, *Decisions are reversible*,
*Fail closed*, *Urgency of consistency follows risk* (a held payout is late, not
lost).

## Design

### 1. Every store item gets a decision

Today an item is either assigned to a bucket or not, and "not" means general
income. The design separates "finance chose general income" from "nobody has
looked at this item yet".

- Finance assigns an item to a bucket **or to general income**. General income
  books the sale without a Class, as an unassigned item does today, but only
  because finance chose it.
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

This removes the need to rebook. A sale never books to general income unless
finance chose that, so there is nothing to move afterwards.

### 2. A bucket without a usable Class raises an alarm and holds what depends on it

- Assigning an item to a bucket is refused when the bucket is archived, has no
  Class, or its Class is not active in QuickBooks. So is any assignment while
  QuickBooks cannot be reached to check the Class; finance tries again later.
- Each run checks every bucket that items are assigned to. When a bucket has
  been archived, has lost its Class, or its Class has been made inactive or
  removed in QuickBooks, the app raises an alarm for finance, the same way it
  reports a cap being hit, and the items list marks every item assigned to that
  bucket. The alarm fires once per bucket, not once per sale, and does not wait
  for a payout to arrive.
- Nothing that depends on that bucket is booked until finance cleans it up: a
  payout with a sale of such an item waits as *needs mapping*, naming the
  bucket, instead of failing. Finance restores the bucket or its Class, or
  reassigns the items; the next run books the payout.
- The app never moves those items elsewhere on its own: the cleanup is
  finance's decision.
- The app does not book part of a payout. A payout is one deposit, so booking
  the good lines and holding the rest would break the one-to-one match.

### States

One new reason a payout waits, alongside no deposit, ambiguous deposit,
failed create and over cap:

| Reason | Means | Clears when |
|---|---|---|
| Needs mapping | A sale's item is undecided, or its bucket is archived or has no active Class | Finance closes the gap; the next run books it |

A held payout is outside the match window's clock: it does not turn into "no
deposit" while it waits. If finance books it by hand instead, the run matches
that deposit, as it would any other.

### Who may act

Only finance assigns items and settles a held payout by hand. Finance and the
board can see the queue and the reasons.

### Security registry

None. The general-income choice goes through the existing item-category route,
which keeps its endpoint, role and response type. The Class check reads
QuickBooks from inside the app, not through a route.

### Migration

The item assignment's bucket column stops being required. A row with no bucket
is a decision for general income; no row is undecided. No data changes:
existing assignments keep their bucket.

Old code serving during the deploy reads an assignment with no bucket as
unassigned, which it books as general income anyway, so the two agree.

### Tests

- Needs mapping: an undecided item holds the payout; deciding releases it on the
  next run; it does not become "no deposit" while held.
- General income: an item marked general income books without a Class and is
  not held.
- Bucket gap: assigning to an archived or classless bucket, or one whose Class
  is inactive, is refused, as is assigning while QuickBooks is unreachable. A
  bucket that loses its Class raises one alarm and marks its items before any
  payout arrives, holds a payout with those sales, and restoring it or
  reassigning the items releases it.

## Open questions for the owner

- **Q1.** Withdrawn: the owner ruled out a takeover date; where booking starts
  is designed separately.
- **Q2.** Resolved: hold the payout. Late books are accepted to cut finance's
  work, as receipts already do (owner, 2026-10-16).
- **Q3.** Resolved: a held payout never books itself as general income; it
  waits until finance fixes it (owner, 2026-10-16).
- **Q4.** Resolved: items map to buckets, not directly to QuickBooks Classes;
  Classes are one to one with buckets, and a one-time event gets its own bucket.
  General income is an assignment with no bucket (owner, 2026-10-16).
- **Q5.** Resolved: an archived bucket, or one whose Class is gone, raises an
  alarm in the app naming what points at it, and nothing that depends on it is
  booked until finance cleans it up (owner, 2026-10-16).
- **Q6.** Resolved: anything already in QuickBooks is out of scope (owner,
  2026-10-16).
- **Q7.** Resolved: an assignment is refused while QuickBooks cannot be reached
  to check the bucket's Class; queuing it for later checking is more code than
  it saves (owner, 2026-10-16).

## Alternatives considered

- **Rebook when an item is assigned later.** The app would have to change or
  reverse a deposit already in QuickBooks, which the register forbids. A
  separate correcting journal entry is possible without editing anything, but
  adds a second kind of QuickBooks write and a reversal story for it. Holding
  until mapped avoids needing either.
- **Book the classed lines, hold the rest.** Splits one payout across two
  deposits and breaks the one-payout, one-deposit match.
- **Default an unclassed bucket's lines to general income.** Silently books a
  sale away from the bucket it belongs to.
- **Map items straight to QuickBooks Classes.** Needs a new Class-list route, a
  second column and a backfill. Since Classes are one to one with buckets, the
  bucket already names the Class.
