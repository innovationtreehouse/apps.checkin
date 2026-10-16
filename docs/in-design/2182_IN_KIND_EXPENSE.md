# In-kind gifts: the expense side

## Problem

A gift of goods is two entries in the books: contribution revenue, and an
expense of the same value (owner ruling). The app records only the first. A
receipt marked in-kind sends its money side to donations, and ops can record a
gift with no receipt, but nothing anywhere records the matching expense. Neither
side reaches QuickBooks; finance books both by hand.

## Objective

Every in-kind gift, with or without a receipt, carries both sides at one value,
so that when the donations drain is switched on it books the pair, and until
then finance's hand bookings can be matched against it.

## Executive summary

- **No separate expense record.** The in-kind gift is the one record. Its expense
  side is the second half of a booking pair, not a row in the expense library.
  One record, one value, so the two sides cannot disagree.
- **It lives in the donations library**, beside the gift. The expense library's
  record assumes a submitter, a reimbursement or card charge, and three-seat
  sign-off; none of that applies to goods given to us.
- **Value comes from the receipt, or from finance.** A gift with a receipt books
  at the receipt's values. A gift without one is valued by finance in a later
  step; ops may suggest a value but does not set it.
- **No spending sign-off.** No money leaves the organisation. Finance setting
  the value is the look before a gift without a receipt books.
- **Every in-kind gift names a budget bucket.** An expense never lands at the
  top of the books without a Class, so an in-kind gift cannot be general money.
  Finance assigns a bucket, which may be a part of the facility such as Facility
  or Shop rather than a program. Each bucket carries its QuickBooks Class (the
  two are one to one), and revenue and expense both carry it.
- **Withdrawal holds or flags, never undoes.** A gift withdrawn before booking
  never books. One withdrawn after booking is raised for finance to reverse by
  hand; the app never changes QuickBooks.
- **Posting** is the in-kind clearing pair already sketched in the bulk-donation
  design (§7 of `1280_BULK_DONATION_INTEGRATION.md`): a Deposit into an in-kind
  clearing account and a Purchase out of it, same date and amount. It ships with
  the donations drain, not before.
- **Donated equipment books as an asset** under the same rules as purchased
  assets: the expense library's capital thresholds, capital review and capital
  register.
- **Program approvers can see** in-kind gifts to their program, without the
  donor. They do not approve them.
- **What this does not build:** donor acknowledgement letters (#2237).

---

## Standing rules this relies on

- A gift of goods is handled as a donation, not as spending, even when it comes
  with a receipt. In the books it is both a donation received and an expense of
  the same value. — `docs/rules/revenue.md`, Donations
- Finance allocates each gift as the donor's instructions or policy direct; once
  recorded the allocation can't be changed in the app. A gift with no
  instructions is general money. — `docs/rules/revenue.md`, Donations
- A gift of goods still missing its donor is raised for finance; once its money
  is recorded the gift is never deleted. — `docs/rules/revenue.md`, Donations
- A reimbursement or card charge reaches the books only once each line is signed
  by three people. — `docs/rules/expenses.md`, Spending sign-off
- Every expense that is not a reimbursement is treated as a Treehouse Card
  charge. — `docs/rules/expenses.md`, Expenses
- The app never changes or deletes anything already in QuickBooks.
  — `docs/rules/revenue.md`, Income
- *Apply once*, *Urgency of consistency follows risk*. — `docs/rules/principles.md`

## Standing rules this would change

`docs/rules/revenue.md`, Donations:

> Each gift goes to a program or fund, or is general Treehouse money. A gift
> that comes with no instructions from the donor is general money.

**Replacement:** the rule stays for gifts of money. A gift of goods always goes
to a budget bucket, because its expense side must carry the bucket's Class; a
gift of goods with no instructions from the donor goes to the bucket finance
chooses, which may be a part of the facility such as Facility or Shop.
[Decision — owner]

`docs/rules/revenue.md`, Donations: "Once recorded, the allocation can't be
changed in the app." **Replacement for gifts of goods:** finance may change a
gift's bucket until the gift books, which is how a bucket that is archived or
loses its Class gets cleaned up; once booked it cannot change. [Decision — owner]

`docs/rules/revenue.md`, Donations and Ownership, which name finance and the
board (plus operations and inventory managers for gifts without a receipt) as
the only readers of gifts:

**Addition:** a program's approvers also see the in-kind gifts given to their
program, without the donor, and do not approve them. The program is the one
the gift's bucket belongs to. [Decision — owner]

`docs/rules/revenue.md`, Ownership: ops record a gift without a receipt;
**addition:** finance sets its value, and ops' value is only a suggestion.
[Decision — owner]

It also adds rules (see the end).

---

## Design

### Why not an expense record

The obvious home for an expense is the expense library. It is the wrong one, for
three reasons that each stand alone:

1. Its record has a submitter, a reimbursement flag, and a rule that anything not
   a reimbursement is a card charge. An in-kind expense is neither, so it would
   be misfiled the moment it was written.
2. Every expense there goes through three-seat sign-off before it books. That
   control exists because money leaves; here none does.
3. Two records for one gift means two values that can drift, and a link between
   two libraries that cannot import each other. One record cannot drift from
   itself.

So the gift stays the record, and "the expense side" means the Purchase half of
its booking pair. The app has two in-kind tables today (gifts that arrived with a
receipt, and gifts recorded without one); both get the same treatment.

### Value and date

Both sides use one value and one date, read from the gift (owner ruling):

- **With a receipt:** the gift books as the receipt says: its lines, its total
  and its date. Nobody re-values it.
- **Without a receipt:** finance sets each line's value in a step after ops
  records the gift. Ops are not placed to judge value, so what ops enters is a
  suggestion, useful when the donor roughly knows what was paid and the item is
  fairly new; finance sees it and decides. The date is the donation date ops
  entered.

A gift with no value (a receipt whose total could not be read, or a gift
finance has not yet valued) is not ready to book and sits in the finance queue.
Whoever values a gift must be outside the donor's household, as whoever records
it already must be.

This changes the no-receipt recording that shipped with #2192, where ops' line
value is required and is the value: it becomes optional and a suggestion, and a
finance-set value sits beside it.

### Linking the two sides: apply once

Each gift gets at most two bookings, one per side, kept in one small table keyed
by the gift and the side: `(org, source, gift id, side)` unique, where `source`
is *receipt* or *manual* and `side` is *revenue* or *expense*. Each booking
carries a match state, the same set every QuickBooks lane uses (see the
closed-books design below), and the QuickBooks entry it claimed, which is unique
per org.

That gives apply once without extra code:

- A rerun finds both bookings and does nothing.
- A run that booked the revenue side and failed on the expense side finishes
  only the expense side next time.
- A QuickBooks entry claimed by one side can never be claimed by another.

The retry key written into QuickBooks is the same tuple, so a create that
succeeded but went unrecorded is found by lookup, not booked twice.

### When a gift is ready to book

A gift books when all of these hold:

- its money side arrived (receipt path) or it was recorded (no-receipt path);
- its donor is recorded;
- every line has a value (finance's, for a gift without a receipt);
- finance has assigned it a bucket, and the bucket is not archived and still has
  its Class;
- any line at or over the capital thresholds has been through capital review;
- it has not been withdrawn.

Until then it waits, and the finance queue says what it waits on. Waiting is the
normal state (*urgency of consistency follows risk*).

### Withdrawal and anomalies

The receipt path already handles withdrawal: a gift withdrawn before its money
arrived is deleted with its donor; one withdrawn after is kept and raised as an
anomaly. This design adds only what happens to the bookings:

- **Withdrawn before booking:** neither side books. The anomaly stays in the
  queue until finance settles it.
- **Withdrawn after one or both sides booked:** nothing in QuickBooks changes.
  The anomaly says which sides were booked, and finance reverses them by hand
  and records that it did. The app never posts a reversal.

Gifts recorded without a receipt cannot be withdrawn in the app today, and this
design does not add that.

### Sign-off

None (owner ruling). The spending sign-off answers *who allowed this money to
leave*, and none leaves. The question that does matter, *is this value honest*,
is answered by the receipt where there is one, and otherwise by finance setting
the value, recorded with who and when. That step is the look; there is no
separate sign-off. Finance assigning the bucket is a second person-step before
anything books.

### Budget bucket and Class

Each in-kind gift names a budget bucket (owner ruling). Buckets and QuickBooks
Classes are one to one, and the bucket already carries its Class, so the bucket
is how a gift reaches a Class:

- The in-kind tables gain a bucket, who assigned it, and when. Finance assigns
  it from the existing bucket list.
- There is no general-money choice: an expense never lands at the top of the
  books. Where the donor gave no instructions, finance picks a bucket that may
  be a part of the facility, such as Facility or Shop, not a program.
- Assigning a bucket that has no Class is refused.
- A bucket that is archived, or loses its Class, later raises one alarm for
  finance and holds every unbooked gift in it. Finance restores the bucket or
  reassigns the gift; the next run books it. The app never reassigns on its own.
- The bucket can change until the gift books, and not after.

Revenue and expense always carry the same bucket's Class (owner ruling), so the
gift nets to zero there. That matches what happened: that part of the
organisation received goods it did not pay for.

### Who sees it

Unchanged from the gift: finance and the board read in-kind gifts, finance
manages them, only finance and the board see the donor. Operations and inventory
managers, who record gifts without a receipt and read those gifts, do not assign
buckets or see booking state.

A program bucket's approvers (its leader and treasurers) can see the in-kind
gifts in their bucket: what was given, its value and date, never the donor.
They do not approve them (owner ruling). An organisation-level bucket such as
Facility or Shop has no approvers, so only finance and the board see those. The
expense side does not appear in the expense library's spending screens.

### Posting to QuickBooks

As sketched in the donations design §7, with the expense side now required, not
optional:

- **Revenue side:** a Deposit into the in-kind clearing account, crediting
  in-kind contribution income.
- **Expense side:** a Purchase out of the clearing account, one line per gift
  line. An ordinary line debits the in-kind expense account; a line capital
  review made an asset debits the fixed-asset account, as a purchased asset's
  would.
- Same date, amount and Class (the bucket's), so clearing nets to zero once both exist. A
  clearing balance that is not zero is a half-booked gift, and the queue shows
  which.

Matching follows the donations design: from our records outward, one narrow
search per booking in the clearing account, each QuickBooks entry claimed once.
When the app may create entries follows the closed-books model shared by every
QuickBooks lane, designed separately ("Replace QuickBooks takeover lines with
closed books + switch-on"), not here. In short: nothing is booked on or before
QuickBooks' books closing date; between that date and in-kind's switch-on the
app only matches, and a gift it cannot match goes to finance to book or skip;
after switch-on it books on its own. In-kind is its own lane with its own
switch-on. Until the drain ships, finance books by hand exactly as today and
nothing in the app changes for them.

In-kind already goes through a clearing account when finance books it by hand
today (owner), so hand bookings are there to match against.

### Donated equipment

A gift of equipment is an asset, not an expense, under the same rules as a
purchased one (owner ruling). The building has such gifts already, so this is a
real case. Those rules already exist in the expense library: its capital
thresholds decide which lines are candidates, finance's capital review decides
which are assets and sets their depreciation cycle, and the capital register
records them. There is one capital register, and it stays in the expense
library; donations does not grow a second one.

So a gift line at or over the expense library's capital thresholds goes to that
library's capital review, through a new port, keyed by the gift line so a resend
does nothing. The register entry records the gift as its source in place of an
expense. The gift waits for the review, then books that line to the fixed-asset
account if it became an asset, or to in-kind expense if not. Thresholds, review
and depreciation are the expense library's, unchanged.

### What gets built, later

When it is built, in this order, each its own PR off `main`:

1. Registry entries for any new route (the finance valuation step, bucket
   assignment, the approver view), alone, per the boundary rule.
2. Donations: per-line values on receipt gifts, the finance valuation step and
   ops' value as a suggestion, the bucket fields and bucket alarm, approver
   visibility, the bookings table, readiness and queue states.
3. Expense: capital review accepts a donated line, and the register records a
   gift as a source.
4. Donations: the pair in the drain (after D and the closed-books design), with
   capital lines booked to the fixed-asset account.

---

## Open questions

- **Q1. Valuation.** Resolved: a receipt gift books per the receipt; finance
  values a gift without one, and ops may suggest. Residual: on a receipt, tax
  and shipping are not on any one line, but the capital test is per line.
  Default: spread them across lines by value, as an asset's cost includes them.
- **Q2. Sign-off on the value.** Resolved: none; finance setting the value is
  the look.
- **Q3. Which bucket carries the expense.** Resolved: the same bucket as the
  revenue.
- **Q4. Program approvers.** Resolved: they see, they do not approve.
- **Q5. QuickBooks setup.** Resolved: in-kind goes through a clearing account
  today. Residual: finance supplies the clearing, in-kind income, in-kind
  expense and fixed-asset account references before switch-on.
- **Q6. Donated equipment.** Resolved: books as an asset under the same rules
  as purchased assets.
- **Q7. Bucket or QuickBooks Class.** Resolved: a budget bucket; buckets and
  Classes are one to one, and the bucket carries the Class. Every gift names
  one.
- **Q8. Which program a gift went to.** Resolved by Q7: the bucket's program.

---

## Rules to extract at merge

- `revenue.md`, Donations: the general-money and allocation replacements above,
  and the bucket rules: a bucket with no Class is refused at assignment, and a
  bucket archived or losing its Class later holds booking and alerts finance.
- `revenue.md`, Donations: both sides of an in-kind gift come from one record
  and one value, in one bucket; the gift takes no spending sign-off; a gift
  withdrawn after booking is raised for finance to reverse by hand.
- `revenue.md`, Donations: a gift with a receipt books at the receipt's values;
  one without is valued by finance, by someone outside the donor's household,
  and ops' value is only a suggestion.
- `revenue.md`, Donations: a program bucket's approvers see in-kind gifts in
  their bucket, without the donor, and do not approve them.
- `expenses.md`: an in-kind gift is not an expense record and never enters
  spending sign-off (pointer to `revenue.md`); donated equipment goes through
  the same capital thresholds, review and register as purchased equipment.

## Provenance

- GitHub issue #2182; related #1270, #2143, #2192; follow-up #2237.
- `docs/in-design/1280_BULK_DONATION_INTEGRATION.md` §2.4, §6, §7.
- `docs/in-design/1272_EXPENSE_QB_INTEGRATION.md` (expense record and sign-off).
