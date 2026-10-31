# Correcting a receipt after it is applied

Design for #2267. The build order is in
`2267_APPLIED_RECEIPT_CORRECTION-migration.md`.

## Problem

When a manager maps a receipt's lines in Part mapping and sends it to apply,
two things happen at once: the goods are counted into stock, and the money goes
to finance as an expense (or, for a donated purchase, as an in-kind gift). After
that the receipt's lines are locked. That lock is right, because a retried apply
must send exactly what the first attempt sent; but it leaves no way to fix a
mistake found later.

Mistakes do get found later. A manager linked a line to the wrong part, so ten
of part A went into stock that are really part B. Or the receipt was read as
"10 at $1.00" when the paper says "1 at $10.00", so stock is nine too high and
the expense line says the wrong thing about what was bought, though its total is
right.

Today each of those is fixed twice, by hand, by different people. An inventory
manager edits the stock count, which records a manual change with no link to the
receipt. Finance separately changes the expense, or doesn't, and the expense's
sign-offs never hear that what they approved changed. Nothing ties the two fixes
together, nothing says why either was made, and a reader of either record can't
tell that the other exists.

The same gap shows up from the other direction. If the receipt side ever sent a
corrected copy of a receipt, receiving would answer with the copy it already
holds and carry on as if nothing had arrived.

## Objective

A person who finds a mistake on a receipt that has been applied records one
correction, with a reason, in receiving. The app then:

- moves stock by the difference, in inventory-log entries that name the receipt
  and the correction;
- changes the expense or the in-kind gift to match, and sends whatever sign-off
  or decision the change affects back through its steps in order;
- records who corrected what, when and why, alongside the receipt as applied,
  which is kept unchanged;
- leaves the books alone. Where the money is already in QuickBooks, finance is
  told and makes the change there.

## Executive summary

**Inventory managers, and the uploader or their household** (the people who may
map a receipt today) get a **Correct** action on an applied receipt. They pick
the lines that were wrong and say what each should have been: a different part,
or not inventory. They give a reason. Stock moves by the difference at once.
(Who corrects what is Q2; the recommendation is that finance alone corrects
quantities and prices.)

**Finance and sign-off seats** see the expense change, with the correction and
its reason in the expense's history. A corrected line goes back to the step the
change affects and is signed again in order, by signers who meet the same
independence rules as the first time. An expense already in QuickBooks isn't
changed; it gets a review saying the receipt was corrected after booking, which
finance closes with a note saying what it did in QuickBooks.

**The uploader and the person reimbursed** see on the receipt that receiving
corrected it. On a reimbursement whose quantities or prices changed, the person
reimbursed confirms again, as the expense rules already require for any change
to what they claimed.

**What does not change.** A finalized receipt stays read-only; the receipt side
never edits or resends it. The receipt as delivered, its line mapping as
applied, and the inventory delta as applied are never rewritten. The app still
only adds to the books. A correction never changes a receipt's total, tax,
shipping or discount (Q1).

**Cost.** Four additive migrations (one per library), one security-boundary PR
for the new routes, one contract PR, and six app and docs PRs. No production
data needs converting: production has no receipts yet.

## Waiting on @thpr

Q1 to Q14 in §9. Each has options and a recommendation. The migrations can land
before any is settled (except PR 1's replay column, which follows Q11); the
contract and everything after it wait on Q1, Q2 and Q8. The rest can be settled
as the PR that needs them comes up.

## Rules this relies on, and the ones it changes

Relied on, unchanged:

- `principles.md`, *The books are finance's*: the app only adds to the books,
  never edits or voids an entry, and a later change goes back to finance. This
  is why a correction after booking (§6) changes nothing in QuickBooks.
- `inventory.md`, On-hand stock: every change to an on-hand count writes an
  inventory-log entry with the change, naming who made it; a receipt adds to
  stock once and a resend with different lines is refused. A correction is a new
  source with its own key (§4), so it never replays the receipt's.
- `inventory.md`, On-hand stock: a backorder is cancelled only with a reason.
  A correction cancels an unfulfilled backorder line with the correction's
  reason (§4.2).
- `expenses.md`, Receipts: a finalized receipt is read-only. Kept (§7).
- `expenses.md`, Spending sign-off: a change to what the submitter claimed (a
  line's quantity or unit price among them) voids the submitter's signature on a
  reimbursement, and it reaches the books only after the person reimbursed
  confirms again. When an earlier step is cleared, every later signature and
  every later step (capital review, depreciation, the QuickBooks step) is
  cleared and done again in order. §5 uses exactly this.
- `expenses.md`, Spending sign-off: every signer is a different person from a
  different household, and the app sets no limit on Board stand-ins (#2717). A
  re-signed line meets the same rules; nothing in a correction relaxes them.
- `expenses.md`, Receipts: lines plus shipping and tax, less discount, equal the
  total. A corrected receipt still balances (§3).
- `expenses.md`, Who may see and do what / Receipts: the conflict rules. A
  conflicted person may not change a receipt's tax or date as finance; §3
  applies the same bar to a quantity or price correction (Q2).
- `revenue.md`, Donations: finance may change a gift's bucket until it starts
  booking. §6 uses "starts booking" as one of the in-kind cut-offs.
- `revenue.md`, Donations: a refused or returned gift's goods are adjusted out
  of stock by hand, never by the app. §6 refuses a correction to such a gift,
  so the app never moves its stock.
- `inventory.md`, Receiving: the uploader, or anyone in their household, may
  map the receipt's lines, with no conflict check, because mapping decides what
  the goods are and not what is paid. §3 and Q2 build on this.
- `expenses.md`, Spending sign-off: a Board authorization, once recorded, is not
  changed. §5.1 keeps it through a clear-back, as finance changing the
  reimbursee already does; Q14 asks whether that reading is right, since the
  same section also clears every later step when an expense goes back.

Changed:

- `inventory.md`, Receiving, the line lock. Today: "A receipt's lines can be
  edited only while it waits for review. Once it is sent to apply, its lines
  can't be edited, even when the apply fails: a failed part is retried with the
  same lines, and a mistake is corrected by hand outside receiving." The lock
  stays; the last clause changes. Proposed text in §10.
- `expenses.md`, Finance review: "Three questions are recorded as reviews."
  A fourth is added, a receipt corrected after its expense booked (Q8).
- `revenue.md`, Donations: a correction to a gift that has started booking is
  raised for finance, as a withdrawal after money is today (Q8, Q9).

## 1. What the app does today

The receipt library finalizes a receipt and delivers it once to workflow-mapping
(`ingestReceipt` in `packages/workflow-mapping/src/services/receiptIntakeService.ts`).
Delivery is idempotent on the receipt id. A second delivery, with the same body
or a different one, gets the stored row's id and state back with
`created: false`, and nothing is recorded.

Workflow-mapping keeps the delivered receipt as JSON and one line-status row per
line (recognized with a GTIN, provisional, non-inventory, or unrecognized).
Lines are editable only in `pending_review` (`EDITABLE_RECEIPT_STATES` in
`src/db/schema.ts`; `lib/line-lock.ts`). Sending to apply moves the receipt to
`applying`, and `lib/apply-receipt.ts` pushes two legs in parallel:

- **Inventory** (X4): the recognized and provisional lines, as raw quantity plus
  conversion factor. Local-inventory applies it under the key
  `receipt:<receiptId>`, and a replay of that key with a different delta is a
  409 (`lib/services/receiptService.ts`). Delayed lines go to the receive queue
  instead of stock.
- **Money**: expense (X5) for a purchase, or bulk-donation (X9) for an in-kind
  receipt, with each line's GTIN or non-inventory mark stitched on. Expense
  stores the payload and builds the expense once; a replay that differs from a
  built expense is a 409 (`services/intakeService.ts`). Bulk-donation writes the
  gift once and stamps a differing replay `replayConflictAt` for finance.

Each leg that succeeds is stamped on the receipt (`inventoryAppliedAt`,
`expenseAppliedAt`, `donationAppliedAt`) and never resent. All stamped gives
`resolved`; a failed leg gives `apply_failed`, retried with the same lines.

Two pieces already exist that a correction can use:

- **Stock adjustments are atomic and logged.** `applyQtyChangeIn` adds a signed
  quantity with an atomic increment and writes the log entry in the same
  transaction. A negative raw quantity already works through it.
- **Expense can send a line back through its steps.** `clearFrom` in
  `packages/expense/src/lib/signoff-facts.ts` clears a line's seats from a given
  step onward, reopens its approval, returns the expense to owner approval,
  clears capital designations, minted assets, holds and the unposted outbox row,
  and audits each clearing. It refuses with "correct it there" once the expense
  is in QuickBooks. Finance changing the reimbursee already uses it.

## 2. The correction

A correction belongs to one receipt in workflow-mapping, the library that owns
the receipt's lines and the push to both sides. It holds:

- a sequence number per receipt (1, 2, ...), which with the receipt id makes the
  key every leg dedupes on;
- who made it and when, and a reason (Q3);
- one row per changed line, with the line's resolution and amounts before and
  after: catalog GTIN or provisional GTIN or non-inventory, conversion factor and
  version, quantity, unit price, line total;
- its own leg stamps and state, as the receipt has: `applying`, then `applied`
  or `apply_failed`.

**Nothing applied is rewritten.** The delivered receipt JSON, the line-status
rows, the inventory delta, the expense payload and the gift as first received
stay as they are. A line's current resolution is its line-status row with every
applied correction laid over it in sequence order. Every reader that today shows
a line's mapping (the receipt page, outcomes for the uploader, the badge counts)
reads this overlay.

**One at a time.** A receipt takes a new correction only when it is `resolved`
(Q4) and its previous correction is `applied`. A correction that failed is
retried, as an apply is, with the same rows; it isn't edited. This keeps the
same guarantee the line lock gives the apply: whatever a retry sends is what the
first attempt sent.

A failed correction must not leave the receipt uncorrectable for good, so it
has one way out besides a retry. While no leg of it has applied, the person who
made it, or anyone allowed to make the same correction, may **withdraw** it,
with a reason. A withdrawn correction is kept, marked with who withdrew it,
when and why, and the receipt takes a new one. Once any leg has applied it can
only be retried, because withdrawing it then would leave one side changed and
the other not; a leg that keeps failing goes to the Apply failed tab like a
receipt's.

**What a line can become.** Linked to a catalog item, or marked not inventory.
Proposing a new catalog item from a correction is Q12; the recommendation is to
leave it out, so a correction never creates a provisional item.

## 3. Who corrects what

A correction has two kinds of change, and they differ in who decides them.

**Mapping** (which part a line is, or that it isn't inventory, and the
conversion factor that comes with the part) decides what the goods are. That is
receiving's decision today, made by inventory managers and also by the receipt's
uploader or anyone in their household, with no conflict check, under
`inventory.md`. The recommendation (Q2) is that a mapping correction is the same
decision made again, by the same people under the same rule. Leaving the
uploader out would mean a person could map a line but not fix their own
mistake. The control on the money side is unchanged: the correction sends the
line back through sign-off (§5), where the conflict rules apply.

**Quantity and unit price** decide what was bought and what the submitter
claimed. If a correction may change them at all (Q1), the recommendation (Q2)
is that only finance makes that part, under the expense conflict rules: a person
who uploaded the receipt or is reimbursed for it, or shares a household with
someone who did, may not. When every finance holder is conflicted, Q13 asks who
makes it; the recommendation is a Board member without a conflict, as for the
Treasurer seat and a gift's decision. A quantity or price correction must leave the receipt
balanced: the corrected line totals plus shipping and tax, less discount, still
equal the receipt total, under the same rounding allowance the receipt check
uses. The receipt total, tax, shipping, discount, date, currency and retailer
are not correctable here (Q1).

One correction may carry both kinds, made by someone allowed both. Under Q2's
recommendation that is a finance holder who also holds the inventory-manager
role; otherwise the two are separate corrections.

## 4. The goods side

Local-inventory takes a correction as a new apply source, keyed
`correction:<receiptId>:<seq>`, so it is applied once and a replay with a
different delta is refused, as a receipt's is. It never touches the
`receipt:<receiptId>` row.

### 4.1 Stock

For each corrected line that was or becomes inventory, the delta is the new
stock contribution minus the old one, per GTIN:

| Before | After | Stock |
|---|---|---|
| Part A, qty q, factor f | Part B, qty q', factor f' | A: minus q×f; B: plus q'×f' |
| Part A, qty q, factor f | Part A, qty q', factor f | A: plus (q'−q)×f |
| Part A | Not inventory | A: minus q×f |
| Not inventory | Part B | B: plus q'×f' |

Each change goes through the same atomic add as a receipt, writes an
inventory-log entry naming the person who made the correction, the receipt id,
and the correction (a new change type, `correction`, and a new
`correction_seq` column), and records raw quantity, factor and version as a
receipt's entry does. The old line's factor is the one recorded when it was
applied, never the catalog's current factor, so the entry exactly undoes what
was added.

A correction that would take any GTIN's on-hand count below zero is Q10. The
recommendation is to refuse the whole correction and name the GTIN, so the
manager recounts first; the recount is its own logged change.

The floor is checked in the same transaction as the write, never read first and
written later, or a receipt applied in between could still take the count
negative. Each decrease is one conditional decrement (subtract only where the
count is at least the amount); if any GTIN's decrement matches no row, the
transaction rolls back and the inventory leg fails naming that GTIN. Increases
keep the atomic upsert-increment, so a concurrent receipt never loses an add.
The screen runs the same check before submitting, as a warning; the
transaction's check is the one that counts.

### 4.2 Delayed lines and provisional items

A delayed line went to the receive queue instead of stock.

- **Not yet fulfilled.** The queue line is cancelled, with the correction's
  reason as the cancel reason, and a new queue line is written for the
  corrected part and quantity, if it is still inventory. No stock moves.
- **Already fulfilled.** Its stock was added at fulfilment, so it is treated as
  a stock line in §4.1.
- **Cancelled.** Nothing was added and nothing is queued again.

A line applied as a provisional item carries its provisional GTIN. If that item
has since been mapped to a real GTIN, the stock the correction reverses sits on
the real GTIN, so the correction follows the provisional-to-real mapping log to
find it. If the provisional item's stock is still unmerged, the correction
reverses it there.

## 5. The money side: expense

Expense takes a correction through a new intake, idempotent on
`<receiptId>:<seq>`, stored first and replayed by the daily catch-up as the
receipt payload is. What it does depends on where the expense is.

### 5.1 Before QuickBooks

"Before QuickBooks" means the expense is in `pending`, `assign_ownership`,
`owner_approval`, `capital_review`, `set_depreciation_cycle`, `qb_pending`,
`qb_on_hold` or `qb_error`, its QuickBooks match state is not `POSTING`,
`CREATED` or `MATCHED`, and it holds no QuickBooks entry id. These are the
states in which `clearFrom` can already send an expense back.

Expense updates each corrected line (GTIN, non-inventory mark, quantity, unit
price, line total) and recomputes the tax, shipping and discount allocations on
every line, since a price change moves each line's share. Every changed field is
written to the expense's history with its before and after values, the
correction's sequence number, its author and its reason.

Then the change re-enters sign-off through `clearFrom`:

| Change | Cleared from | Why |
|---|---|---|
| Quantity or price, reimbursement | Submitter seat, every line | Existing rule: a change to what the submitter claimed voids their signature |
| Quantity or price, card charge | Approval, the changed lines | The approver approved an amount (Q5) |
| Part only | Approval, the changed lines | The approver approved a specific item; the signed GTIN, category and subcategory are what changed (Q5) |

No caller clears from the approval step today; finance changing the reimbursee
clears from the Treasurer, and a voided submitter confirmation from the
submitter. The approval path in `clearFrom` exists but nothing exercises it, so
PR 8 adds integration tests for it: the approval reopens, later seats clear,
and an expense past owner approval returns there with every later step
cleared.

Every later signature on those lines clears with it, and an expense past owner
approval goes back there; capital review, depreciation and the QuickBooks step
are redone in order. This is the existing behaviour of `clearFrom`, already
audited; the reason it records is "receipt corrected (#<seq>): <reason>". The
people who sign again meet the same independence rules as before. A person who
signed the first time may sign the same seat again, because their seat was
cleared; they still may not take a different step than the one they signed.

A recorded Board authorization stays, as it does today when finance changes the
reimbursee: `clearFrom` clears Board seats but not the authorization. Two rules
meet here. "Once recorded, it is not changed" keeps it; "every later step's
result is cleared" could be read to clear it, since recording it is a signature
at the Board step. The design follows the first, because the authorization is
the Board's decision about the charge, made outside the app, and a correction
does not change the total, which is what the $2,000 approval threshold reads.
Q14 asks @thpr to confirm. The Everyday check, which reads the largest single item, can
change with a unit price; whether it is recomputed is Q7.

A part correction does not move the line's bucket. Finance chose or confirmed
the bucket, and finance may move it, as today (Q6).

### 5.2 In or past QuickBooks

Expense decides which case applies from the expense's own state before it
touches anything; it doesn't rely on `clearFrom`'s guard, which looks only at
the match state and entry id. An expense in `qb_complete` with a match state of
`AMBIGUOUS` or `NEEDS_FINANCE` would pass that guard, but its entry is queued
or waiting on finance to settle, so it belongs here. The guard stays as a
backstop.

This case covers three different relations to the books, and the review says
which one:

- **Booked**: `qb_complete`, or a match state of `POSTING`, `CREATED` or
  `MATCHED`, or an entry id. The app's entry, or finance's entry it matched,
  shows the old lines.
- **Backfill**: an imported receipt, already booked by finance before the app
  saw it, which ended at `qb_skipped` without posting. Finance's own entry shows
  the old lines.
- **Skipped**: finance skipped the expense (`SKIPPED`), giving a reason. The app
  never books it, but finance may have booked it by hand; finance knows, the app
  doesn't.

In each, the app can't change the books, and must not let the expense disagree
with finance's view of the purchase without telling finance. The recommendation
(Q8, option A):

- the expense's lines are not changed;
- the correction is stored, and the expense gets a new review, **Receipt
  corrected after booking**, that names the correction and lists each line's
  before and after;
- finance closes it with a note saying what it did in QuickBooks, or that
  nothing was needed (a blank note is refused), as with the other three reviews.

This review is distinct from the existing "closed expense that never posted"
review. That one asks why an expense the app meant to book has no entry; this
one says the purchase changed after the expense left the app's hands.

Stock still moves (§4); the goods were wrong whatever the books say.

A rejected expense takes the correction into its history and nothing else.

## 6. The money side: in-kind gift

Bulk-donation takes a correction through a new intake, idempotent on
`<receiptId>:<seq>`. A gift's lines carry GTIN, quantity and value. Its
cut-off has two markers, and either one ends in-place correction:

- **Started booking**: a booking side exists, or the posting is `POSTING` or
  has a create attempt. This is the check the bucket change uses today.
- **Sent to capital review**: `capitalSubmittedAt` is set, so the accepted
  lines are already in expense's donated-capital review. The bucket check
  ignores this marker, because changing a bucket only resends to capital
  review; a correction changes the lines themselves, which capital review has
  already taken.

| Where the gift is | What the correction does |
|---|---|
| Not yet decided | Updates the gift's lines, with history; the decider sees the corrected goods |
| Accepted, neither marker set | Updates the lines and clears the decision, which is made again (Q9) |
| Accepted, either marker set | Lines unchanged; raised for finance (`correctionPendingAt`, shown in finance's queue with the before and after) and settled with a note, by the same path as a withdrawal after money (Q8) |
| Refused or returned | The whole correction is refused before anything moves. Those goods were adjusted out of stock by hand, and the app never adjusts them |

The gift's total never changes (Q1), so its booked value stays right; what can
go wrong after booking is the description and the capital treatment of a line.

## 7. A corrected copy from the receipt side

The receipt side can't produce a corrected copy, and this design keeps it that
way. A finalized receipt is read-only under the expense rules, and the receipt
library sends what it finalized. The only things that resend are the daily
catch-up and finance's **Send downstream**, which resend the same receipt.

A differing body can still reach intake: a contract-version change that alters
how a receipt serializes, or a defect. Intake must stay idempotent, because the
receipt side treats an error as a failed push and keeps resending; a 409 would
turn one defect into a daily failure with no person to clear it. The
recommendation (Q11, option A):

- intake keeps answering with the stored row;
- it records two things, which do different jobs. An audit event,
  `receipt_replay_differs`, is written once per distinct body (its details hold
  the body's hash and the first fields that differ), so the history shows every
  different copy. A column on the receipt, `replay_differs_at`, holds when the
  latest one arrived, so the receiving page can show "A different copy of this
  receipt arrived after it was received; nothing was changed. If it is right,
  correct the receipt." without searching the audit log. Making a correction,
  or dismissing the notice, clears the column; the audit events stay.

Today intake records nothing for a replay, so this is new behaviour, built in
PR 10.

So a correction is always entered by a person in receiving, against the copy
receiving holds. Turning a resent copy into a correction automatically was
considered and rejected (Appendix B).

## 8. States and screens

Workflow-mapping gains a correction state machine beside the receipt's:

```
applying ──► applied
   │
   └──────► apply_failed ──(retry)──► applying
```

A push claims the correction with the same lease the receipt apply uses, pushes
the goods leg and the money leg in parallel, and stamps each leg that succeeds.
The stuck-apply sweep covers corrections as well. A receipt whose latest
correction is `apply_failed` shows in the Apply failed tab, and its count in the
nav pill.

On the receipt page in receiving:

- **Correct** opens the receipt's lines as they stand, with the same part
  picker Part mapping uses, a quantity and price editor shown only to finance
  (Q2), and a required reason (Q3). It shows the stock change per GTIN and,
  before submitting, what it will send back for sign-off ("3 lines go back to
  their approver"; "the reimbursee confirms again"; "already in QuickBooks:
  finance will be asked to correct it there").
- **Corrections** lists each one: sequence, who, when, why, lines before and
  after, and each leg's state, with **Retry** on a failed one and **Withdraw**
  while none of it has applied.

Expense's detail shows the correction in its history, and the new review in
finance's queue. The gift's accept screen shows corrected lines marked as such.
The uploader's purchase outcome shows "Corrected in receiving on <date>".

Errors (a refused stock floor, a stale screen, a conflicted finance holder) are
red chips that stay until dismissed and say what was refused and why.

## 9. Open questions for @thpr

Numbers are fixed IDs; a settled question keeps its number.

| # | Question | Options | Recommendation |
|---|---|---|---|
| Q1 | What may a correction change? | **A** mapping only (part, not inventory, factor). **B** A, plus a line's quantity and unit price, with the receipt still balancing and its total unchanged. **C** B, plus total, tax, shipping and discount. | **B.** A misread quantity is the other common mistake and it moves stock. C reopens the submitter's claim, finance's tax review, the $2,000 Board threshold and the books; a wrong total is better handled by finance by hand until it happens. |
| Q2 | Who makes each part? | **A** inventory managers make all of it. **B** whoever may map the receipt (inventory managers, and the uploader or their household) corrects the mapping; finance corrects quantity and price, under the expense conflict rules. **C** as B, but inventory managers only for the mapping. **D** finance all of it. | **B.** Mapping is a decision the uploader may make today, so they may fix it; sign-off still controls the money. Quantity and price are the money claimed, which only finance changes today. |
| Q3 | Is a reason required? | **A** required, blank refused, kept on the correction and in each log and audit entry. **B** optional. | **A**, as cancelling a backorder requires one. |
| Q4 | Which receipts can be corrected? | **A** `resolved` only. **B** also `apply_failed` with some leg applied. | **A.** A failed apply is retried first; correcting a half-applied receipt means two pushes in flight for one receipt. |
| Q5 | Which sign-off step does a change send a line back to? | **A** quantity or price: submitter seat on a reimbursement, approval on a card charge; part only: approval. **B** part only clears from the Treasurer, not the approval. **C** a part-only change is bookkeeping and clears nothing. | **A.** The approver approved a specific item and amount. |
| Q6 | Does a part correction move the line's bucket? | **A** no; finance may move it. **B** yes, to the new part's owner, unless finance had moved it. | **A.** Finance decides buckets. |
| Q7 | Is the Everyday check recomputed when a unit price is corrected? | **A** yes. **B** no, it stays as frozen at creation. | **A.** The freeze guards against settings changes, not against the receipt being wrong. |
| Q8 | What happens when the money is already booked or skipped? | **A** stock moves; the money record is unchanged and gets a review (expense) or is raised (gift) for finance to close with a note. **B** refuse the whole correction. **C** stock moves; the money side is only recorded in history. | **A.** B leaves stock wrong; C changes the books' twin without telling finance. |
| Q9 | Does a correction clear an in-kind gift's decision when it hasn't started booking? | **A** yes, decided again. **B** no, the decision stands. | **A.** The decider decided about the goods that changed. |
| Q10 | A correction would take stock below zero. | **A** refuse it and name the GTIN; recount first. **B** allow a negative count and flag it. **C** stop at zero. | **A.** B and C each leave a count nobody counted. |
| Q11 | A different copy of a received receipt arrives. | **A** answer with the stored copy, record it, show it on the receipt. **B** as today, silently. **C** refuse with a 409. | **A.** See §7. |
| Q12 | May a correction propose a new catalog item? | **A** no; link to an item or mark not inventory. **B** yes, creating a provisional item. | **A** for the first build. Propose the item in the catalog, then correct to it. |
| Q13 | Every finance holder is conflicted on a receipt whose quantity or price needs correcting. | **A** a Board member without a conflict corrects it. **B** nobody can; the receipt is corrected by hand outside the app. | **A**, as a Board member takes the Treasurer seat or decides a gift when every finance holder is conflicted. |
| Q14 | Does a correction that sends an expense back keep a recorded Board authorization? | **A** yes; it is not changed once recorded, and the total it covers hasn't changed. **B** no; it is a Board-step result and clears with later steps. | **A**, which is also what finance changing the reimbursee does today. |

## 10. Rules this design establishes

To be written into the register at merge, in the domains below. Wording assumes
the recommendations; each changes with its question.

**`inventory.md`, Receiving** (replaces the line-lock rule):

- A receipt's lines can be edited only while it waits for review. Once it is
  sent to apply, its lines can't be edited, even when the apply fails: a failed
  part is retried with the same lines. A mistake found after a receipt is
  applied is fixed by a correction: a new entry, with a reason, applied to the
  goods and the money side as one change, whichever of them it moves. The
  receipt, its lines and its stock entries as applied are never rewritten.
  `[Decision — owner]`
- A correction is made only on a receipt that is fully applied, one at a time:
  a receipt takes a new correction only once its last one has applied or been
  withdrawn. A failed correction is retried as it was made, or withdrawn with a
  reason while none of it has applied. `[Decision — owner]`
- Whoever may map a receipt's lines may correct which part a line is, or that
  it is not inventory. A line's quantity and price are corrected only by
  finance, under the conflict rules in `expenses.md`, or by a Board member
  without a conflict when every finance holder is conflicted.
  `[Decision — owner]`
- A correction never takes a count below zero; one that would is refused.
  `[Decision — owner]`

**`inventory.md`, On-hand stock** (added):

- A correction's stock change reverses exactly what the line added, at the
  factor it was added with, and is logged naming the receipt and the
  correction. `[Decision]`

**`expenses.md`, Receipts** (added):

- A correction changes a receipt's lines only: never its total, tax, shipping,
  discount, date, currency or retailer, and the receipt still balances
  afterwards. `[Decision — owner]`

**`expenses.md`, Spending sign-off** (added):

- A correction to a line's part sends it back to its approval; one to its
  quantity or price sends a reimbursement back to the submitter's confirmation
  and a card charge's line back to its approval. Later signatures and steps
  clear and are done again, as for any earlier step. `[Decision — owner]`

**`expenses.md`, Finance review** (replaces the three-reviews rule):

- Four questions are recorded as reviews, because no fix records their
  answer: a duplicate QuickBooks entry to void, an entry changed in QuickBooks
  after posting, a closed expense that never posted, and a receipt corrected
  after its expense was booked, imported as already booked, or skipped by
  finance. Finance closes each with a note
  saying what it did, and a blank note is refused. A closed expense's review
  closes on its own once the expense posts. `[Decision — owner]`

**`revenue.md`, Donations** (added):

- A correction to a gift of goods that has neither started booking nor gone to
  capital review changes its lines and clears its decision. One that has
  started booking or gone to capital review is raised for finance, which fixes
  the books by hand and settles it with a note; the app changes nothing in the
  books. A refused or returned gift is never corrected. `[Decision — owner]`

## Appendix A: what the correction carries between libraries

One new contract type, `ReceiptCorrection`, in `@checkin/receipt-types`
(contract version 1.4.0, additive):

```
{ orgId, receiptId, seq, correctedBy: { userId, username }, reason, correctedAt,
  isInKind,
  lines: [{ receiptLineItemId,
            before: { gtin13 | null, isProvisional, nonInventory, conversionFactor,
                      conversionVersion, quantity, unitPriceCents, totalPriceCents, isDelayed },
            after:  { same fields } }] }
```

Workflow-mapping derives the inventory delta from it and sends the whole thing
to the money side. Each library's port gains one method:
`InventorySink.applyCorrection`, `ExpenseSink.applyCorrection`,
`DonationSink.applyCorrection`, bound in
`checkin-app/src/lib/workflowMapping/configure.ts`.

## Appendix B: alternatives considered

- **Let the receipt side reopen and resend, and diff the copy into a
  correction.** Rejected. It breaks "a finalized receipt is read-only", reruns
  finance review on a receipt whose goods are in stock, and makes intake guess
  which person made the change and why. The person who found the mistake is in
  receiving; that is where it is recorded.
- **Unlock the lines after apply and re-push the whole receipt.** Rejected. It
  rewrites what was applied, and every sink would need to accept a replay that
  differs, which is the guard that stops double-counting today.
- **Reverse the whole receipt and apply a fresh one.** Rejected. It clears every
  sign-off on every line, not only the changed ones, and doubles the log entries
  for a one-line fix.
- **Two linked manual fixes, a stock edit and an expense edit sharing a
  reference.** Rejected. It keeps the two-person, two-screen fix, and nothing
  makes the second happen.
