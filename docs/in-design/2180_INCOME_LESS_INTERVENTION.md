# Income: less routine work for finance

Design for #2180. Working doc: nothing here is true yet.

## Problem

The app books each Shopify payout into QuickBooks as a deposit, split by the
program each sale belongs to. Three things push routine work back onto finance:

1. **The app starts booking only after finance books one by hand.** The point
   where the app takes over is worked out from the newest payout finance booked
   themselves. Until finance has booked one, the app books nothing. Every payout
   on or before that point is finance's, so booking August by hand while July is
   still open makes July finance's job too.
2. **A sale of an item nobody has assigned is booked as general income, for
   good.** Assigning the item to a program afterwards only affects later sales.
   The earlier ones stay in general income unless finance moves them in
   QuickBooks by hand.
3. **One program without its QuickBooks Class sends the whole payout to
   finance.** The app refuses to book the payout, and finance has to book all of
   it by hand, including the sales that had nothing wrong with them.

## Objective

The app books every payout on its own once finance has made two kinds of
decision: the date from which the app books, and which program each store item
belongs to. Finance's queue holds only payouts that need a person, and a gap
finance closes clears the payouts it was holding without anyone touching them.

## Summary

- **Finance:** sets the takeover date once. Assigns each new store item to a
  program or to general income, once per item. A payout held for an item or a
  Class books itself as soon as the gap is closed.
- **Board:** no change. Sees income as today.
- **Does not change:** the app still never edits or deletes anything in
  QuickBooks; every payout still matches exactly one deposit; a payout or
  deposit that changes after matching still goes back to finance.
- **Cost:** two small schema additions, one new reason a payout waits, no new
  routes, no security registry change.

## Rules this relies on or changes

Changes, in `docs/rules/revenue.md` § Income:

- "Finance's own bookings come first. The app books only payouts newer than the
  last one finance booked by hand…" becomes: the app books payouts after the
  takeover date finance sets, or after the newest one finance booked by hand if
  that is later.
- "Sales finance hasn't assigned are booked as general Treehouse income" becomes:
  a payout with a sale of an item finance has not decided on waits until finance
  assigns the item, to a program or to general income.

Relies on, unchanged: the app never changes or deletes anything already in
QuickBooks; every payout matches one deposit; a changed payout goes back to
finance; only finance settles problems. From `principles.md`: *Accountability*,
*Decisions are reversible*, *Fail closed*, *Urgency of consistency follows risk*
(a held payout is late, not lost).

## Design

### 1. A takeover date finance sets

A new org setting: the takeover date. The app creates deposits only for payouts
dated after the later of this date and the newest payout finance booked by hand.
This is how expense posting already works.

- With no date set, the line is the newest hand-booked payout, as today, so
  nothing changes until finance sets one and no cutover step is needed.
- Payouts on or before the line behave as today: matched to finance's deposit,
  or raised as having no deposit once the match window passes.
- **Who:** only finance sets or changes the date.
- **Audit:** a settings change, written with before and after, as the caps are.
- **Reversal:** finance sets it back. Deposits the app created in between stay
  in QuickBooks, as any app booking does; moving the date never undoes one.

### 2. Every store item gets a decision

Today an item is either assigned to a program or not, and "not" means general
income. The design separates "finance chose general income" from "nobody has
looked at this item yet".

- Finance can assign an item to a program **or to general income**.
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

Items already assigned keep their program. Items sold before this ships and
booked to general income stay as they are.

### 3. A Class gap holds the payout, and is blocked where it starts

- Finance can no longer assign an item to a program that has no QuickBooks
  Class. (Assigning to an archived program is already refused.)
- If a program loses its Class or is archived after items were assigned to it,
  a payout with those sales waits as *needs mapping*, naming the program,
  instead of failing. Finance gives the program a Class or reassigns the items;
  the next run books the payout.
- The app does not book part of a payout. A payout is one deposit, so booking
  the good lines and holding the rest would break the one-to-one match.

### States

One new reason a payout waits, alongside no deposit, ambiguous deposit,
failed create and over cap:

| Reason | Means | Clears when |
|---|---|---|
| Needs mapping | A sale's item is undecided, or its program has no Class or is archived | Finance closes the gap; the next run books it |

A held payout is outside the match window's clock: it does not turn into "no
deposit" while it waits. If finance books it by hand instead, the run matches
that deposit, as it would any other.

### Who may act

Only finance sets the takeover date, assigns items, and settles a held payout by
hand. Finance and the board can see the queue and the reasons.

### Security registry

None. The date goes through the existing settings route, and the general-income
choice through the existing item-category route; neither changes its endpoint,
role or response type. The new fields carry the same internal tier as their
neighbours.

### Migration

Additive only:

- the org settings gain a nullable takeover date;
- an item assignment may hold "general income" (a nullable program, or a flag;
  see Q4).

Old code serving during the deploy reads a general-income assignment as
unassigned, which it books as general income anyway, so the two agree.

### Tests

- Takeover date: none set books nothing; set books after it; a later hand
  booking moves the line forward and never back.
- Needs mapping: an undecided item holds the payout; deciding releases it on the
  next run; it does not become "no deposit" while held.
- Class gap: assigning to a program with no Class is refused; a program losing
  its Class holds, and restoring it releases.

## Open questions for the owner

- **Q1.** Who may set the takeover date: finance only (proposed), or finance and
  the board? Should moving it *earlier*, which lets the app book older payouts,
  take the board, as raising a cap does?
- **Q2.** Holding a payout for an undecided item makes the books later instead
  of wrong. Is that the trade you want, or should an undecided item still book
  as general income and finance correct it later?
- **Q3.** Should a held payout ever book itself as general income after some
  time (say 30 days), or wait for finance indefinitely? Proposed: wait.
- **Q4.** Storage for "general income" on an item: allow an empty program on the
  existing assignment (one relaxed column), or a separate flag (purely
  additive)? Proposed: the empty program.
- **Q5.** When a program is archived, should its items move to general income on
  their own, or wait for finance to reassign them? Proposed: wait, so a
  decision about money stays with finance.
- **Q6.** Rebooking sales already booked to general income before this ships:
  out of scope (proposed), or a one-off correction finance does in QuickBooks?

## Alternatives considered

- **Rebook when an item is assigned later.** The app would have to change or
  reverse a deposit already in QuickBooks, which the register forbids. A
  separate correcting journal entry is possible without editing anything, but
  adds a second kind of QuickBooks write and a reversal story for it. Holding
  until mapped avoids needing either.
- **Book the classed lines, hold the rest.** Splits one payout across two
  deposits and breaks the one-payout, one-deposit match.
- **Default an unclassed program's lines to general income.** Silently credits
  a program's sales to the wrong place.
