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
- **Finance accepts every gift before anything happens.** Every in-kind gift,
  with or without a receipt, goes through a finance *accept donation* step:
  accept, refuse or return. Nothing books to QuickBooks and no donor letter goes
  out until a finance holder accepts it; under charity law the letter is an act
  of the organisation. Nobody accepts a gift where they or their household is
  the donor or the recorder; if every finance holder is conflicted, a Board
  member accepts. The screen warns; it does not decide.
- **Value comes from the receipt, or from the accepter.** A gift with a receipt
  books at the receipt's values. A gift without one is valued by finance as part
  of accepting it; ops may suggest a value but does not set it.
- **No spending sign-off.** No money leaves the organisation. Acceptance is the
  one person-step a gift needs.
- **Every in-kind gift names a budget bucket.** An expense never lands at the
  top of the books without a Class, so an in-kind gift cannot be general money.
  Finance assigns a bucket, which may be a part of the facility such as Facility
  or Shop rather than a program. Each bucket carries its QuickBooks Class (the
  two are one to one), and revenue and expense both carry it.
- **Withdrawal holds or flags, never undoes.** A gift withdrawn before booking
  never books. One withdrawn after booking is raised for finance to reverse by
  hand; the app never changes QuickBooks.
- **Posting** is one QuickBooks journal entry per gift: in-kind contribution
  income credited with the gift's value, and each line debited to in-kind
  expense, or to fixed assets once capital review makes it an asset. Finance's
  past bookings went through a clearing account as a Deposit and a Purchase; the
  drain matches those first and never books a gift twice.
- **Donated equipment books as an asset** under the same rules as purchased
  assets: the expense library's capital thresholds, capital review and capital
  register.
- **Program approvers can see** in-kind gifts to their program, without the
  donor. They do not approve them.
- **What this does not build:** donor acknowledgement letters (#2237), which go
  out only for an accepted gift. A letter for a gift of goods describes the
  goods and never states a value; the value the app records is for the books
  only.

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
**addition:** finance sets its value when accepting it, and ops' value is only a
suggestion. [Decision — owner]

`docs/rules/revenue.md`, Donations; **addition:** every gift of goods is accepted,
refused or returned by a finance holder before it books or any letter goes out.
Nobody decides on a gift where they or their household is the donor or the
recorder; a Board member decides when every finance holder is conflicted.
[Decision — owner; *Policy: Ethics Policy, Art. III §III.5*]

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

So the gift stays the record, and "the expense side" means the debit lines of
its journal entry. The app has two in-kind tables today (gifts that arrived with a
receipt, and gifts recorded without one); both get the same treatment.

### Value and date

Both sides use one value and one date, read from the gift (owner ruling):

- **With a receipt:** the gift books as the receipt says: its lines, its total
  and its date. Nobody re-values it.
- **Without a receipt:** finance sets each line's value when accepting the
  gift (below). Ops are not placed to judge value, so what ops enters is a
  suggestion, useful when the donor roughly knows what was paid and the item is
  fairly new; finance sees it and decides. The date is the donation date ops
  entered.

A gift with no value (a receipt whose total could not be read) cannot be
accepted until finance resolves the total; it sits in the finance queue.

The value is for the books only. It never appears in the donor's
acknowledgement: under federal rules for nonprofits, a letter for a gift of
goods describes the goods and states no value, which is between the donor and
their tax advisor. Only a gift of money states its amount (owner ruling).

### Accepting a gift

Every in-kind gift, with or without a receipt, waits for a finance holder to
decide it (owner ruling). Taking a gift, and thanking its donor for it in
writing, are acts of the organisation, so a person makes them. Until then
nothing books and no letter goes out (#2237).

**Outcomes.** One decision per gift, recorded with who and when:

- **Accept.** The accepter sets the value of a gift without a receipt (a gift
  with one keeps the receipt's values) and assigns the bucket. The gift can then
  book, and its letter, which describes the goods without a value, can go out.
- **Refuse.** We do not take the gift. Nothing books and no letter goes out.
- **Return.** We give the goods back. Nothing books and no letter goes out.

Refusal and return are rare and handled outside the app (owner ruling). The
app does not take goods back out of inventory; if stock needs adjusting, finance
or ops does it by hand. The app does nothing special with a refused or returned
gift's record or donor details.

**Who may decide.** A finance holder, but not one who is, or shares a household
with, the donor, or whoever uploaded the receipt or recorded the gift. The app
knows the uploader and recorder and their households, so it enforces those. It
does not know the donor's household, because donors are not linked to people,
so the accepter confirms they are outside it, and that confirmation is recorded.
A finance holder who is conflicted steps aside on that gift. When every finance
holder is conflicted, a Board member without a conflict decides instead: the
same substitution the spending sign-off uses for the Treasurer seat.

**Warnings, not gates.** The surname comparison at recording is beaten by a
spelling variant, a maiden name or a company name, so it cannot clear a gift on
its own. The accept screen shows it, with the others, as warnings for the
person deciding:

- the donor's surname matches someone in the accepter's household;
- the donor is the uploader or recorder;
- the value is at or over the expense library's large-spend amount (its $500
  awareness setting, reused, not a new one);
- the donor was replaced after the gift was recorded.

None of these blocks a decision; the decider reads them and decides (*a financial
control is a flag a person signs off*). The check that counts is the
independent person.

This changes the no-receipt recording that shipped with #2192, where ops' line
value is required and is the value: it becomes optional and a suggestion, and a
finance-set value sits beside it.

### Linking the two sides: apply once

Each gift holds its QuickBooks entries in one small table keyed by the gift and
the side: `(org, source, gift id, side)` unique, where `source` is *receipt* or
*manual*. The side is *journal* for the app's one journal entry, which books
both sides at once, or *revenue* and *expense* for the Deposit and Purchase
finance booked by hand. Each entry is unique per org and QuickBooks entry kind,
since QuickBooks numbers each kind separately. A second table keeps one row per
gift for its way to QuickBooks: its match state (the set every lane uses, see
the closed-books design below), the drain's claim, the first create attempt, a
note for finance, and the total and date as booked.

That gives apply once without extra code:

- A rerun finds the gift booked and does nothing.
- A QuickBooks entry one gift holds can never be held by another.
- A gift is booked whole or not at all: one journal entry, or both halves of
  finance's pair claimed together.

The retry key written into QuickBooks names the org, source and gift, so a
create that succeeded but went unrecorded is found by lookup, not booked twice.

### When a gift is ready to book

A gift books when all of these hold:

- its money side arrived (receipt path) or it was recorded (no-receipt path);
- its donor is recorded;
- it has been accepted, which gives every line a value and assigns a bucket;
- its bucket is not archived and still has its Class;
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

No spending sign-off (owner ruling). That sign-off answers *who allowed this
money to leave*, and none leaves. The questions that do matter for a gift, *do we
take it* and *is its value honest*, are answered by acceptance: one independent
finance holder, or a Board member when finance is conflicted, recorded with who
and when.

### Budget bucket and Class

Each in-kind gift names a budget bucket (owner ruling). Buckets and QuickBooks
Classes are one to one, and the bucket already carries its Class, so the bucket
is how a gift reaches a Class:

- The in-kind tables gain a bucket, who assigned it, and when. Finance assigns
  it from the existing bucket list when accepting the gift.
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

Each gift books as one journal entry, dated as the gift, with the bucket's Class
on every line (owner, 2026-10-25):

- **Credit:** in-kind contribution income, for the gift's value.
- **Debit:** one line per gift line. An ordinary line debits in-kind expense; a
  line capital review made an asset debits fixed assets, as a purchased asset's
  would. A receipt's tax and shipping are spread across its lines by value, the
  same spread capital review used, so the debits equal the credit and an asset's
  cost equals its register cost.

Finance names the three accounts, and the clearing account below, in the books
map. The lane does not run until all four are set, and the clearing account can
never be a lane's bank account. One entry means the gift can never sit half
booked. In-kind is the only part of the app that books journal entries, so no
other lane can claim one; and the app's writer creates a journal entry only
through an in-kind function that refuses any account outside these roles and
any entry that does not balance.

**A gift books only when booking is all it waits on.** A gift with a line still
in capital review, a held bucket, or anything else outstanding waits, however
long that takes.

**Matching finance's own bookings.** Until now finance booked each gift by hand
as a Deposit into an in-kind clearing account and a Purchase out of it, same
amount. Before it creates anything, the drain looks for that pair: one Deposit
into the clearing account and one Purchase out of it, each for the gift's value,
within a week of its date, carrying no app key and held by no other gift. Both
found, and no other unbooked gift of the same value could own them, is a match;
the gift claims both entries in one transaction, and the unique index is the
guard. Anything less goes to finance: one half without the other, two
candidates, or two gifts that could each own the pair. A journal entry finance
booked by hand is never matched on its amount; finance matches it to the gift by
its id, and only when it is for the gift's value with every line on an in-kind
account. The pair's accounts are the clearing account, which no other lane books
to, so income and expense can never see these entries. The clearing account
can be no other lane's account in the books map, so no other lane holds a
Deposit in it.

**Finance's actions.** A gift the drain hands over (unbooked, needs finance, or
failed) offers three actions, each audited with who did it. *Book* creates the
entry now, before switch-on if need be, only when booking is all the gift waits
on and never in closed books. *Skip* needs a reason; the gift leaves the queue
and the drain for good. *Match* takes a journal entry id, or a Deposit and a
Purchase id. Skip and match first look for the app's own entry when a create
may have landed, and link it instead. A gift's bucket cannot change once a
create has been attempted, since that entry carries the bucket's Class. A gift
with a QuickBooks note, such as the sweep's stray entry, stays in the queue
until finance *clears* the note with how it was answered; the stray entries it
named are recorded as answered, and the sweep never notes them again.

**When the app may create** follows the closed-books model shared by every
QuickBooks lane (`QB_CLOSED_BOOKS.md`): nothing is booked on or before
QuickBooks' books closing date; between that date and in-kind's switch-on the
app only matches, and a gift it cannot match goes to finance to book or skip;
after switch-on a gift books on its own. A gift counts as created when its
money side arrived (receipt) or when ops recorded it (no receipt). In-kind is
its own lane with its own switch-on, set the first time its drain runs with
QuickBooks connected and every in-kind role in the books map. Before each create
it re-reads the closing date, and a create QuickBooks refuses as closed (fault
6210) is held for finance, never retried as a failure. A gift whose create may
have landed looks for its own entry by key before anything else, and a daily
sweep reports any app entry its gift does not hold.

The app stores the total and date it booked. A check that finance later edited
a booked entry is not built yet.

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

Requirements the build carries, from a security review of what is on `main`:

- **Cap a gift without a receipt.** Recording one today limits each line's
  quantity and value but not how many lines there are or what they total. Add a
  ceiling on both.
- **A receipt replay never changes a gift's value.** The money side's resend
  today overwrites the stored total and date. A repeat with the same values does
  nothing; one that differs is refused and raised for finance, not merged
  (*apply once*).
- **Donor details do not outlive a withdrawal.** A gift withdrawn after its money
  arrived keeps its donor details today. Once finance settles that anomaly
  (reversing any booking by hand), the donor details are cleared; the gift
  record and its money stay, since a gift with money recorded is never deleted.

In this order, each its own PR off `main`:

1. Registry entries for any new route (the accept step, the approver view),
   alone, per the boundary rule.
2. Donations: per-line values on receipt gifts; the accept step with its three
   outcomes, its conflict rule, Board substitution and four warnings (which
   needs the gift to record when its donor was replaced); ops' value as a
   suggestion; the bucket fields and bucket alarm; approver visibility; the
   bookings table, readiness and queue states; and the three requirements
   above.
3. Expense: capital review accepts a donated line, and the register records a
   gift as a source.
4. Donations: one journal entry per gift in the drain, matching finance's
   clearing-account pairs first, with capital lines booked to the fixed-asset
   account. Finance books, skips (with a reason) or matches by id each gift the
   drain hands over, through the two in-kind `qb-resolve` routes.

---

## Open questions

- **Q1. Valuation.** Resolved: a receipt gift books per the receipt; finance
  values a gift without one, and ops may suggest. A receipt's tax and shipping
  are spread across its lines by value, for capital review and for the journal
  entry's debit lines alike.
- **Q2. Sign-off on the value.** Resolved: no spending sign-off; every gift is
  accepted, refused or returned by an independent finance holder (or a Board
  member when finance is conflicted), and accepting sets the value of a gift
  without a receipt.
- **Q3. Which bucket carries the expense.** Resolved: the same bucket as the
  revenue.
- **Q4. Program approvers.** Resolved: they see, they do not approve.
- **Q5. QuickBooks setup.** Resolved: finance sets the in-kind income, in-kind
  expense, fixed-asset and clearing accounts in the books map; the lane does not
  run until all four are set. The clearing account is only for matching
  finance's past bookings.
- **Q6. Donated equipment.** Resolved: books as an asset under the same rules
  as purchased assets.
- **Q7. Bucket or QuickBooks Class.** Resolved: a budget bucket; buckets and
  Classes are one to one, and the bucket carries the Class. Every gift names
  one.
- **Q8. Which program a gift went to.** Resolved by Q7: the bucket's program.
- **Q9. Goods of a refused or returned gift.** Resolved: handled outside the
  app; no automatic inventory removal, stock adjusted by hand if ever needed.
- **Q10. The value warning's threshold.** Resolved: the expense library's
  large-spend amount (its $500 awareness setting), reused.
- **Q11. Donor details after a refusal or return.** Resolved: outside the app;
  the app does nothing special with them.

---

## Rules to extract at merge

- `revenue.md`, Donations: the general-money and allocation replacements above,
  and the bucket rules: a bucket with no Class is refused at assignment, and a
  bucket archived or losing its Class later holds booking and alerts finance.
- `revenue.md`, Donations: both sides of an in-kind gift come from one record
  and one value, in one bucket; the gift takes no spending sign-off; a gift
  withdrawn after booking is raised for finance to reverse by hand.
- `revenue.md`, Donations: the accept-step addition above. A gift with a
  receipt books at the receipt's values; one without is valued by its accepter,
  and ops' value is only a suggestion. The accept screen's surname, uploader,
  value and replaced-donor checks only warn. No donor letter goes out before
  acceptance.
- `revenue.md`, Donations: an acknowledgement for a gift of goods describes the
  goods and states no value; a gift of money states its amount.
- `revenue.md`, Donations: once finance settles a gift withdrawn after its
  money arrived, its donor details are cleared. A refused or returned gift's
  goods are adjusted out of stock by hand, never by the app.
- `revenue.md`, Donations: a program bucket's approvers see in-kind gifts in
  their bucket, without the donor, and do not approve them.
- `expenses.md`: an in-kind gift is not an expense record and never enters
  spending sign-off (pointer to `revenue.md`); donated equipment goes through
  the same capital thresholds, review and register as purchased equipment.

## Provenance

- GitHub issue #2182; related #1270, #2143, #2192; follow-up #2237.
- `docs/in-design/1280_BULK_DONATION_INTEGRATION.md` §2.4, §6, §7.
- `docs/in-design/1272_EXPENSE_QB_INTEGRATION.md` (expense record and sign-off).
