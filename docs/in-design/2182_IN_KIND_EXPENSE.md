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
- **No spending sign-off.** No money leaves the organisation. The controls that
  already exist on recording the gift (donor named, recorder outside the donor's
  household) stay the controls.
- **Same budget bucket on both sides.** Finance assigns the gift a bucket, as it
  does a Benevity gift; revenue and expense carry that bucket's Class.
- **Withdrawal holds or flags, never undoes.** A gift withdrawn before booking
  never books. One withdrawn after booking is raised for finance to reverse by
  hand; the app never changes QuickBooks.
- **Posting** is the in-kind clearing pair already sketched in the bulk-donation
  design (§7 of `1280_BULK_DONATION_INTEGRATION.md`): a Deposit into an in-kind
  clearing account and a Purchase out of it, same date and amount. It ships with
  the donations drain, not before.
- **What this does not build:** valuation rules beyond the recorded value,
  capitalising donated equipment, donor acknowledgement letters.

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

None. It adds rules (see the end).

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

Both sides use one value and one date, read from the gift:

- **With a receipt:** the receipt total and receipt date the money side carried.
- **Without a receipt:** the sum of its lines' values, and the donation date ops
  entered.

A gift with no value (a receipt whose total could not be read) is not ready to
book and sits in the finance queue. Whether a receipt total is the right measure
of a gift's value, tax and shipping included, is open question Q1.

### Linking the two sides: apply once

Each gift gets at most two bookings, one per side, kept in one small table keyed
by the gift and the side: `(org, source, gift id, side)` unique, where `source`
is *receipt* or *manual* and `side` is *revenue* or *expense*. Each booking
carries the match state the donations design already defines (`UNMATCHED`,
`MATCHED`, `CREATED`, `AMBIGUOUS`, `BEFORE_LINE`, `POST_FAILED`) and the
QuickBooks entry it claimed, which is unique per org.

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
- it has a value;
- finance has assigned it a bucket, or marked it general money;
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

None. The issue already states it, and the reasoning is short: the spending
sign-off answers *who allowed this money to leave*, and none leaves. The
question that does matter, *is this value honest*, is answered at recording
(donor named, recorder outside the donor's household) and again when finance
assigns the bucket, which is a person looking at the gift before it can book.
Whether that look should be an explicit recorded sign-off on the value is open
question Q2.

### Budget bucket and Class

The in-kind tables gain the same allocation fields Benevity gifts have: a bucket
or a general-money mark, who assigned it, and when. Finance assigns it, and it
cannot change once set (the existing donations rule). Both sides of the booking
carry that bucket's QuickBooks Class; general money carries none, as for
Benevity.

Revenue and expense in one bucket net to zero in that bucket. That matches what
happened: the program received goods it did not pay for. Whether the expense
should instead sit with the bucket that uses the goods is open question Q3.

### Who sees it

Unchanged from the gift: finance and the board read in-kind gifts, finance
manages them, only finance and the board see the donor. Operations and inventory
managers, who record gifts without a receipt and read those gifts, do not assign
buckets or see booking state.

The expense side does not appear in the expense library's screens, and program
approvers do not see it in their bucket's spending. It shows in QuickBooks under
the bucket's Class. Whether approvers should see in-kind gifts to their program
is open question Q4.

### Posting to QuickBooks

As sketched in the donations design §7, with the expense side now required, not
optional:

- **Revenue side:** a Deposit into the in-kind clearing account, crediting
  in-kind contribution income.
- **Expense side:** a Purchase out of the clearing account, debiting the in-kind
  expense account.
- Same date, amount and Class, so clearing nets to zero once both exist. A
  clearing balance that is not zero is a half-booked gift, and the queue shows
  which.

Matching follows the donations design: from our records outward, one narrow
search per booking in the clearing account, each QuickBooks entry claimed once.
The in-kind stream has its own takeover line; with no matched record it has no
line and creates nothing. So nothing posts until finance has hand-booked at
least one gift through the clearing account and the app has matched it. Until
the drain ships, finance books by hand exactly as today and nothing in the app
changes for them.

What finance must confirm before the drain posts anything is open question Q5.

### What gets built, later

No code until the owner rules. When it is built, it is one donations-library PR
after the drain (D) lands: the allocation fields on both in-kind tables, the
bookings table, the readiness check, the queue states, and the pair in the
drain. A checkin-side registry change for any new route ships first, alone, per
the boundary rule.

---

## Open questions

- **Q1. Valuation.** Is a donor's receipt total, tax and shipping included, the
  value booked? Default: yes, the total as read, with finance free to correct the
  value before it books. A gift with no receipt uses the values ops entered.
- **Q2. A recorded sign-off on the value?** Default: no; finance assigning the
  bucket is the look. The alternative is one finance sign-off on value, recorded
  like an expense sign-off but with a single seat.
- **Q3. Which bucket carries the expense.** Default: the same bucket as the
  revenue, so the gift nets to zero there.
- **Q4. Program approvers see in-kind gifts to their program?** Default: no;
  finance and the board only, as today.
- **Q5. Finance confirms the QuickBooks setup:** the clearing account (it must
  be a type QuickBooks accepts as both a Deposit's destination and a Purchase's
  paying account), the in-kind income account, and the in-kind expense account
  (one account, or one per kind of goods). And: does finance book in-kind gifts
  through a clearing account today? If not, matching finds nothing and the stream
  never gets a takeover line until finance books one that way.
- **Q6. Donated equipment.** Should a gift of equipment above the capitalisation
  threshold book as an asset, not an expense, and enter the capital register?
  Default: out of scope; finance handles those by hand and the app books them as
  expense like any other gift.

---

## Rules to extract at merge

- `revenue.md`, Donations: both sides of an in-kind gift come from one record
  and one value; the gift takes no spending sign-off; a gift withdrawn after
  booking is raised for finance to reverse by hand.
- `expenses.md`: an in-kind gift is not an expense record and never enters
  spending sign-off (pointer to `revenue.md`).

## Provenance

- GitHub issue #2182; related #1270, #2143, #2192.
- `docs/in-design/1280_BULK_DONATION_INTEGRATION.md` §2.4, §6, §7.
- `docs/in-design/1272_EXPENSE_QB_INTEGRATION.md` (expense record and sign-off).
