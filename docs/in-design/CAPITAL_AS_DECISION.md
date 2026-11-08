# Capital as a decision, not a second flow

## Problem

When the organisation buys a piece of equipment worth keeping on the books, or
is given one, finance decides that it is a capital asset: it gets an asset
number on the capital register, a depreciation period, an owning bucket, and it
books to a fixed-asset account rather than an expense account. The rules say a
donated item goes through the same thresholds, the same review and the same
register as a purchased one.

The app does not do that. A purchase is judged capital on the expense itself.
A gift is judged capital somewhere else: once finance accepts it, the app copies
its lines into a separate list owned by the expense side, finance reviews them
on a different page from the gift, and the asset numbers are minted from that
copy. The gift then asks the expense side, every time it is shown or booked,
which of its lines turned out to be assets.

Because the decision lives on a copy and not on the gift, the two drift:

- A gift withdrawn after it was accepted keeps its copied lines and its asset
  numbers. Finance can still review the copy and mint numbers for goods the
  organisation no longer has.
- A gift moved to another bucket after its lines were copied keeps the old
  bucket on the copy, and the review screen offers the old bucket.
- A gift's capital review can never be redone. A purchase's can, and when it is,
  its asset numbers are deleted and may later be issued to a different asset.

And the two paths do not apply the same rules. The thresholds are compared
differently, so a gift can skip review that the same purchase would get. The
cost on the register differs: a purchased asset is registered without its
tax and shipping, a donated one with them. A purchased asset can book to an
ordinary expense account; a donated one cannot. Five writes on the way leave no
record of who did them.

Who is hurt: finance, whose register and fixed-asset accounts cannot be trusted
to agree with each other or with the goods; and the auditor who later asks why
asset ITFA31 has two histories.

## Objective

Capital is a decision finance records on the line it is about, the expense line
or the gift line, in the record's own flow. Both kinds of line reach one
threshold test, one kind of review and one register by the same rules. The
register holds a link back to the line that made each asset, never a copy of
the line. Every capital write, on either side, leaves an audit row naming who
did it, and reversing a decision reverses everything it made.

## Executive summary

- **For finance.** A gift's capital decision is taken on the gift, in the gift
  queue, where "waiting on capital review" already shows. The separate Donated
  Equipment page goes. A purchase's capital review does not move.
- **For the register.** It gains one link per asset to the line that made it,
  the expense line or the gift line, and loses the copied list. An asset that is
  undone is retired, not deleted, and its number is never issued again.
- **For booking.** A gift books its asset lines from the decision stored on its
  own lines. It no longer asks the expense side at booking time.
- **Same rules both ways.** One threshold test, one cost basis and one
  account-type rule serve both paths. Which test, which cost and which account
  rule are owner questions (CAD-1 to CAD-3, CAD-11); this design does not pick.
- **What does not change.** A gift is still a donation and never an expense
  record. Bucket, accept, refuse and return, and the gift's one journal entry are
  unchanged. Purchased capital review and depreciation keep their place in the
  expense flow.
- **Cost.** Columns on the gift lines and on the register; a small register
  service in the expense library that both flows call; one cross-database step
  for gifts, retried by the in-kind drain; a backfill; and later, dropping the
  copied list and its two routes in a decommission PR.

## Rules this relies on

From `docs/rules/expenses.md`:

- Donated equipment goes through the same capital thresholds, review and
  register as purchased equipment. *(Receipts)*
- A gift of goods is a donation, not an expense record. *(Receipts)*
- The capital register holds one row per physical asset, and an asset number is
  used once per org. *(Capital register)*
- Finance works from one queue; each reason to act is shown on the record it is
  about, with the action that answers it. *(Finance review)*
- When an expense goes back to an earlier step, the capital review, the
  depreciation cycle and its assets are cleared and done again, and each clearing
  is recorded. *(Spending sign-off)*
- Classifying a signed-off purchase, its capital designation, depreciation cycle
  and owner bucket included, is bookkeeping any finance holder may do. *(Receipts
  and conflicts)*
- Only a rule marked capital may give donated equipment its account, which must
  be fixed-asset; a rule marked capital takes only a fixed-asset account, any
  other rule an expense or cost-of-goods account. *(Accounts)*

From `docs/rules/revenue.md`:

- A gift of goods is both a donation and an expense of the same value, from one
  record, in one bucket.
- Finance may change a gift's bucket until it starts booking.
- A gift withdrawn after its money arrived is raised for finance; finance
  reverses any booking by hand.

This design changes none of them. Several owner questions below would add a rule
(see "Rules this design would establish").

## 1. How it works today

Two libraries, two databases. **bulk-donation** owns gifts of goods: the
receipt gift (`InKindDonation`, `InKindDonationLine`) and the gift without a
receipt (`ManualInKindDonation`, `ManualInKindDonationLine`), their booking
(`InKindPosting`, `InKindBooking`) and their history (`WorkflowEvent`).
**expense** owns expenses (`Expense`, `ExpenseLineItem`), the capital register
(`CapitalAsset`), the copied gift lines (`DonatedCapitalLine`), the thresholds
(`ExpenseOrgSettings`), the account rules (`AccountMapping`) and two audit logs
(`ExpenseAuditLog` per expense, `ExpenseOrgAuditLog` org-wide). The host,
`checkin-app/src/lib/bulkDonation/configure.ts`, wires bulk-donation's
`InKindCapital` port to expense's functions.

### 1.1 A purchased line

| Step | Where | Writes | Audit |
|---|---|---|---|
| All line approvals terminal; thresholds tested on the whole expense | `expense/src/lib/financial-flow.ts:107`, `classifyCapital` in `lib/expense-rules.ts:24` | `Expense.state` → `capital_review` | state transition row |
| Finance designates **every** line capital or not, with an owner | `POST /api/expense/expenses/[id]/capital-review/submit` → `submitCapitalReview`, `services/capitalService.ts:63` | `ExpenseLineItem.isCapital`, `capitalOwnerId`; drops a hand-set account when the designation flips | `capital_designation_set` per line; state |
| Finance sets each capital line's years and owner; assets minted | `POST …/set-depreciation-cycle/submit` → `setDepreciationCycle`, `capitalService.ts:118` | `ExpenseLineItem.depreciationYears`, `capitalOwnerId`; `CapitalAsset` one per unit (`sourceExpenseId`, `sourceLineItemId`) | `depreciation_cycle_set` per line; **no row per asset** |
| Account resolved, line booked | `lib/expense-qb-processor.ts`, `lib/account-rules.ts` | `resolvedQbAccount`, allocations; the Bill or Purchase | posting rows |
| Expense sent back to an earlier step | `clearStepsAfterOwnerApproval`, `lib/signoff-facts.ts:288` | clears designations; **deletes** the non-seeded `CapitalAsset` rows | `capital_designation_cleared`, `capital_asset_cleared` per asset |

Everything above runs in one database, and each step is one transaction with its
state change. An expense already in QuickBooks cannot go back
(`signoff-facts.ts:290`).

### 1.2 A donated line

| Step | Where | Writes | Audit |
|---|---|---|---|
| Finance accepts the gift and picks its bucket | `POST /api/donations/in-kind/{manual,receipt}/[id]/decision` → `decide`, `bulk-donation/src/services/inKindAcceptService.ts:463` | decision, bucket; a manual gift's line values | `IN_KIND_DECIDED` (`WorkflowEvent`) |
| After commit, the gift's lines are **copied** to expense | `sendToCapitalReview`, `inKindAcceptService.ts:559` → port `InKindCapital.submit` → `submitDonatedLines`, `expense/src/services/donatedCapitalService.ts:42` | `DonatedCapitalLine` for each line over the thresholds, carrying description, quantity, cost, date, **bucket** | **none** |
| The gift is stamped as sent | `inKindAcceptService.ts:583-585` | `capitalSubmittedAt` | **none** |
| Finance reviews each copied line on Expense → Donated Equipment | `POST /api/expense/donated-capital/[id]/review` → `reviewDonatedLine`, `donatedCapitalService.ts:87` | `DonatedCapitalLine.isCapital`, years, owner; `CapitalAsset` one per unit (`sourceDonatedLineId`) | `capital_review_submitted` org row whose `after` is the request; **asset numbers not recorded** |
| The gift waits on "capital" while any copy is unreviewed | `waitingOn`, `inKindAcceptService.ts:295`, reading `giftsAwaitingCapitalReview` across databases on every queue, page and drain read | — | — |
| The gift books; asset lines debit a fixed-asset account | `journalLines`, `bulk-donation/src/lib/in-kind-poster.ts:263`, asking `donatedAssetLineIds` across databases at post time | journal entry, `InKindBooking` | posting events |

Records created as copies of another library's record: `DonatedCapitalLine`
(of each gift line, with its bucket). Records created from a copy:
`CapitalAsset` rows with `sourceDonatedLineId` point at the copy, never at the
gift line. A purchased asset points at the line itself (`sourceLineItemId`).

Steps not atomic across libraries: accept → copy; copy → stamp; review →
the gift learning its lines are assets (a live read, never recorded on the
gift); withdrawal → nothing on the expense side at all.

Who owns what: bulk-donation owns the gift, its lines, its bucket and its
booking. Expense owns the register, the thresholds, the account rules and the
copy. Today the gift's capital decision is owned by expense, on the copy.

## 2. Bugs found

Each with where it shows. Line numbers are at `main` 7734c351e.

| # | What goes wrong | Evidence |
|---|---|---|
| B1 | **A withdrawn gift keeps its capital lines and assets.** Withdrawal and its settlement touch only the gift. The copied lines are not filtered by the gift's state, so an unreviewed copy stays on the Donated Equipment page and can still be reviewed and minted; assets already minted stay on the register. A purchase undone clears its assets. | `withdraw` and `settle`, `bulk-donation/src/services/inKindService.ts:130,155`; `listDonatedCapital` and `giftsAwaitingCapitalReview`, `donatedCapitalService.ts:54,74` filter only `isCapital: null`; contrast `signoff-facts.ts:296-316` |
| B2 | **A gift's capital review can never be redone.** A second review is refused and nothing clears the first. A purchase goes back and is reviewed again. A wrong "not capital" or wrong period on a gift is permanent in the app. | `reviewDonatedLine`, `donatedCapitalService.ts:100-110` |
| B3 | **A bucket change leaves the copy on the old bucket.** Finance may re-accept a gift into another bucket until it starts booking. Once the copy was sent, re-accepting sends nothing, so the copy keeps the old bucket, and the review screen pre-fills the owner from it. | `decide`, `inKindAcceptService.ts:495-503`; `pages/donatedCapital.tsx:35` |
| B4 | **The thresholds are compared differently.** A purchase goes to review when the receipt total is over the total threshold or any line's unit price is over the unit threshold, and then finance designates every line. A gift's line goes to review only when **that line's own cost** is over the total threshold or its first unit's share is over the unit threshold; lines under it are never reviewed. Example below. | `financial-flow.ts:107`; `donatedCapitalService.ts:46-48` |
| B5 | **The register's cost differs.** A purchased asset's cost is the line's unit price for every unit: no share of tax, shipping or discount, and for a fractional quantity the units do not sum to the line. A donated asset's cost includes its share of the receipt's tax and shipping, and the units sum exactly. The threshold test differs the same way. | `capitalService.ts:167`; booked amount `expense/src/qb-write.ts:11`; `inKindAcceptService.ts:171-180`, `donatedCapitalService.ts:37` |
| B6 | **A purchased asset can book to an expense account.** A purchased capital line matches account rules with no capital mark as well as those marked capital; a rule with no mark may only hold an expense or cost-of-goods account. When only such a rule covers the part, the line books there while the register lists it as an asset. A donated asset only matches rules marked capital, so it holds for finance instead. | `matchesRule`, `expense/src/lib/account-rules.ts:12,17`; `donatedPartAccount`, `account-rules.ts:29`; type checked only when a rule or a hand-set account is saved, `routes/finance.ts:84`, `services/holdService.ts:31` |
| B7 | **An asset number can be issued twice.** Sending an expense back deletes its assets, and the next number is the highest left plus one. When the deleted assets held the highest numbers, the next asset minted, on any expense or gift, gets one of them. | `signoff-facts.ts:312-313`; `nextItfaSeq`, `expense/src/lib/capital-register.ts:40` |
| B8 | **One asset can enter the register twice.** A backfilled expense still runs capital review so the register is built from it, and the seed loads historical asset numbers from QuickBooks. The seed skips only a number already on the register, so a historical purchase both backfilled and seeded gets two rows with two numbers. | `Expense.backfill` comment, `expense/prisma/schema.prisma`; `seedCapitalAssets`, `capitalService.ts:213-229` |
| B9 | **Half-complete accepts.** The gift commits as accepted before its lines are copied. A failed copy leaves it accepted and waiting on capital until a person accepts it again; nothing retries. A copy that lands but whose stamp fails leaves the expense side holding lines the gift says it never sent. | `sendToCapitalReview`, `inKindAcceptService.ts:559-585` |
| B10 | **The gift does not know what it booked.** Which lines booked as assets is read live from the expense database at post time and never stored on the gift. A later change on the expense side (B2's fix, a correction by hand) changes the answer for a gift already booked, and a failed read fails the queue, the page and the drain together. | `in-kind-poster.ts:269`; `in-kind-resolve.ts:247`; `listQueue`, `inKindAcceptService.ts:317-325` |
| B11 | **The review is not the same review.** A purchase takes two steps, designate then period, and finance may mark any line capital. A gift takes one step, capital, period and owner together, and only over-threshold lines are offered. The gift's reason to act shows on the gift; the action is on a separate expense page. | `capitalService.ts:63,118`; `DonatedCapitalReviewSchema`, `donatedCapitalService.ts:77`; `expense/src/nav.ts:92` |
| B12 | **Five capital writes leave no audit row of their own.** The copy, the sent stamp, each purchased asset minted, each donated asset minted (the review row stores the request, not the numbers), and the gift's knowledge of which lines are assets. Only clearing a purchase names the asset numbers. | as above; `capitalService.ts:161`, `donatedCapitalService.ts:117,133-138` |

**B4 example.** Total threshold $2,500, unit threshold $1,000.

- Bought: a receipt for six chairs at $450, $2,700 in all. Total over $2,500, so
  the expense goes to capital review, and finance decides each line.
- Given: the same receipt marked as a gift. The one line's cost, $2,700, is
  compared with the **total** threshold and goes to review. Fine so far.
- Given: the same six chairs as six lines of one chair each. Each line is $450,
  under both thresholds. Nothing is reviewed; the gift books every chair to an
  expense account. As a purchase, the $2,700 total would have sent it to review.

**B5 example.** A $1,000 table, 8% tax, $50 shipping.

- Bought: booked at $1,130 to the line's account; registered at $1,000.
- Given, with the same receipt: booked at $1,130 to a fixed-asset account;
  registered at $1,130.

**B7 example.** The register holds ITFA01 to ITFA30. An expense mints ITFA31
and ITFA32 for two lathes, then is sent back for a signature. Both rows are
deleted, and the clearing rows name them. A donated drill press is then reviewed
and minted as ITFA31. The lathes are reviewed again and become ITFA32 and ITFA33.
A sticker reading ITFA31 is now on a lathe, and the register says ITFA31 is a
drill press.

**Double booking in QuickBooks.** None found that the app makes by itself. A
gift has one journal entry, and a purchase one Bill or Purchase; register rows
book nothing, and the app books no depreciation. The risks are around it: B6
puts an asset on an expense account; B1 relies on finance reversing a withdrawn
gift by hand while its assets stay listed; B8 doubles the register, which any
future depreciation run would double-book.

## 3. Designs

Three ways to make capital a decision on the original line, then the
recommendation. Each says how the shared threshold, review, register and
depreciation are reached.

### Option A — the decision on the line, the register as a service (recommended)

Each flow records the capital decision on its own line, in its own database,
in the same transaction as its audit row. The register stays in the expense
library and is reached through one small service that both flows call, keyed by
a link to the line, never a copy of it.

**On the gift line** (both gift tables), new columns:

| Column | Meaning |
|---|---|
| `capitalReview` | `not_needed` (under the thresholds), `pending`, `capital`, `not_capital` |
| `depreciationYears` | set when capital |
| `capitalBucketId` | the owning bucket, set when capital |
| `capitalDecidedByUserId`, `capitalDecidedAt` | who decided and when |
| `registeredAt` | when the register confirmed this line's assets |

**On the expense line**, nothing new: it already holds `isCapital`,
`capitalOwnerId` and `depreciationYears`.

**Thresholds.** The expense library exports one pure test, used by both flows,
with the settings read through the existing settings port:

```ts
// expense, exported
capitalReviewNeeded(
  record: { totalCents: number; lines: { id: number; unitCostCents: number }[] },
  settings: CapitalThresholds,
): { needed: boolean; lineIds: number[] }   // which lines finance must decide
```

Whether `lineIds` is every line of a record over the threshold or only the
lines over it is CAD-3. Whether `unitCostCents` carries its share of tax and
shipping is CAD-2. The test is the same for both callers either way.

**Review.** Finance decides on the record:

- an expense: the two existing steps, unchanged;
- a gift: on the gift's own page and queue row, where "waiting on capital"
  already shows. One new route,
  `POST /api/donations/in-kind/{manual,receipt}/[id]/capital`, taking the same
  shape as the expense steps. Whether that is one step or two, and whether it is
  part of the accept, are CAD-4 and CAD-5.

Writing the decision is local: it updates the gift lines and records an
`IN_KIND_CAPITAL_DECIDED` event in one transaction. The gift's `waitingOn` reads
its own lines; the cross-database `awaitingReview` read goes.

**Register.** The expense library exposes a register service:

```ts
interface CapitalRegister {
  /** Mints one asset per unit for the line; a repeat for the same line returns the same numbers. */
  register(orgId: string, source: AssetSource, units: AssetUnit[]): Promise<string[]>;
  /** Retires the line's assets with a reason; numbers are never reissued. */
  retire(orgId: string, source: AssetSource, reason: string): Promise<void>;
  assetsOf(orgId: string, source: AssetSource): Promise<{ assetNumber: string; status: string }[]>;
}
type AssetSource =
  | { kind: "expense_line"; lineItemId: number }
  | { kind: "gift_line"; giftSource: "receipt" | "manual"; giftId: number; giftLineId: number };
interface AssetUnit { costCents: number; acquisitionDate: string | null; depreciationYears: number; description: string }
```

`CapitalAsset` gains `sourceKind`, `sourceGiftSource`, `sourceGiftId`,
`sourceGiftLineId` and `unitIndex`, with a unique index on
(org, source, unit index). That index is what makes `register` repeatable
without a copy of the line. `status` gains `retired`, and the next number is
the highest **ever** issued plus one, retired rows included (CAD-7).

- The expense flow calls it in-process, inside the depreciation step's
  transaction, as today: atomic.
- The gift flow cannot share a transaction with it. The decision commits with
  `registeredAt` empty; the in-kind drain, which already runs per gift, calls
  `register` and then stamps `registeredAt`. A crash between the two is safe:
  the next run calls `register` again and gets the same numbers. Whether the gift
  waits for its numbers before booking is CAD-10.

**Booking.** The gift's journal entry reads `capitalReview = capital` from its
own lines. `assetLineIds` and the cross-database read at post time go (B10).
The account rule that applies follows CAD-11 for both kinds of line.

**Reversal, both ways the same.**

- An expense sent back: its assets are retired, not deleted (B7).
- A gift's capital decision changed before it books: its assets are retired and
  the line registered again.
- A withdrawal settled: the gift's assets are retired (CAD-8).
- After booking: per CAD-6.

**Audit.** Each library audits its own write in the transaction that makes it:

| Write | Row |
|---|---|
| A gift line's decision | `IN_KIND_CAPITAL_DECIDED` event on the gift, per line: before and after |
| A gift's registration stamp | `IN_KIND_CAPITAL_REGISTERED` event, naming the asset numbers |
| Each asset minted, either flow | `ExpenseOrgAuditLog` `capital_asset_registered`: number, source link, cost |
| Each asset retired | `ExpenseOrgAuditLog` `capital_asset_retired`: number, source link, reason |
| An expense line's designation and period | unchanged |

**Library boundaries.** bulk-donation owns the gift's decision; expense owns
the thresholds, the account rules and the register. The only cross-library
calls are reads of settings and the idempotent `register` and `retire`, behind
the existing `InKindCapital` port, reshaped. Nothing is copied.

**What it fixes.** B1 (retire at settle), B2 (the gift's decision is editable
until booking, like a purchase's), B3 (the bucket is on the gift), B4 and B5
(one test, one cost), B7 (retire, never delete), B9 (the drain retries; no
hand re-accept), B10 (the decision is on the gift), B11 (the review is on the
record), B12 (every write audited). B6 follows CAD-11. B8 needs CAD-12.

### Option B — a capital library of its own

As A, but the register, the thresholds and the review step's shared parts move
into a new library with its own database. Expense and bulk-donation both call
it across a boundary.

- **For:** the register belongs to neither purchases nor gifts, which is how
  the rule reads. A third kind of asset, such as a fabricated one, has a home.
- **Against:** the purchase path loses the atomic mint it has today: its
  depreciation step and its assets would sit in two databases, and it would need
  the same drain-and-stamp the gift needs. The thresholds move out of the
  expense settings, which finance edits today. More to migrate, for no bug A
  leaves open.

A's register service is the interface B would expose, so A can become B later
without the flows changing (CAD-9).

### Option C — the gift becomes an expense record

The accepted gift creates an expense, marked as donated, which walks the
existing capital review.

Rejected. It contradicts two standing decisions: a gift of goods is a donation,
not an expense record (`expenses.md`), and it books from one record
(`revenue.md`). It would also put a gift through spending sign-off, which the
rules say it never needs. Only an owner decision to change those rules would
reopen it.

### Not chosen: fix the copy in place

Keep the copied list and patch B1 to B3 and B9 one by one: a withdrawal hook,
a bucket resend, a review undo, a retry sweep. Each patch is another
cross-library write keeping a copy in step. It leaves B10 and B11 as they are,
and is the shape @thpr has asked to move away from.

## 4. Recommendation

Option A. It puts the decision on the gift line and on the expense line, in
each record's own flow; it reaches the one register through a link; it keeps the
purchase path atomic; and it fixes every bug found except B8, which needs an
answer first. Build it after CAD-1 to CAD-8 and CAD-10 to CAD-11 are answered.
The cutover is in `CAPITAL_AS_DECISION-migration.md`.

## 5. Open questions

For @thpr. Numbers are fixed; a settled question keeps its number.

| # | Question | What it decides | Example |
|---|---|---|---|
| CAD-1 | For a gift, is the **total** threshold compared with the gift's total, as a purchase compares the receipt's total, or with each line's own cost, as today? | Whether a gift split into many small lines can skip review | Six $450 chairs as six lines: by gift total ($2,700) they are reviewed; by line (each $450) they are not |
| CAD-2 | Does an asset's register cost, and the cost compared with the unit threshold, include its share of tax, shipping and discount? Today a purchase leaves them out and a gift puts them in. | One cost basis for the register and for the test | $1,000 table, $80 tax, $50 shipping: registered at $1,000 or $1,130, for both |
| CAD-3 | Once a record is over a threshold, does finance decide **every** line, as for a purchase, or only the lines over the threshold, as for a gift? | Whether a cheap line on an expensive record can be made capital | A $3,000 receipt: a $2,800 laser and a $200 lens kit. Every line: finance may register the kit with the laser. Only over: the kit is never asked about |
| CAD-4 | Does finance take a gift's capital decision **as part of accepting it**, or as its own step after, on the gift's page? | Whether accept stays one quick act; who may take it | As part of accept: the accepter, under the accept conflict rule. After: any finance holder, as classifying a purchase is |
| CAD-5 | One review step (capital, period and owner together, as a gift today) or two (designate, then period and owner, as a purchase today), for both? | One review shape | — |
| CAD-6 | May a capital decision change **after** the record has booked? Today neither path allows it. If so, does the app retire and re-register, leaving finance to correct QuickBooks by hand? | Whether a booked mistake is fixed in the app or only in the books | Finance marks a donated 3D printer "not capital", it books to an expense account, and finance finds the mistake a month later |
| CAD-7 | When an asset is undone, is its number retired for good, or may it be issued again? The rule says "used once"; the code reissues it (B7). | Whether numbers are physical labels | ITFA31 is cleared: does the next asset become ITFA31 or ITFA32? |
| CAD-8 | When finance settles a withdrawn gift, are its assets retired by the app, or does finance retire them by hand with a reason? | Who undoes the register for a withdrawal | — |
| CAD-9 | Does the register stay in the expense library (Option A), or move to a library of its own (Option B), now or later? | Library ownership | — |
| CAD-10 | Does a gift wait for its asset numbers before it books, as a purchase does? | Whether a gift can be in the books with no register row yet | The expense database is down for an hour: the gift waits, or books and registers later |
| CAD-11 | May a purchased capital line book to an account from a rule with no capital mark, as today, or must it hold for finance like a donated one? | B6: whether an asset can sit on an expense account | Finance marks a $4,000 CNC router capital; only the "Shop tools → Tools expense" rule covers it |
| CAD-12 | For historical assets, which wins: the register built by backfilled expenses, or the numbers seeded from QuickBooks? Should a backfilled expense mint assets at all when the seed is loaded? | B8: one row per physical asset | A 2024 table saw is in QuickBooks as ITFA07 and is also a backfilled expense that mints ITFA41 |

## 6. Rules this design would establish

Candidates only. Each becomes a rule in `docs/rules/expenses.md` once its
question is answered, and not before.

- A capital decision is recorded on the line it is about, by finance, with who
  and when, whether the line is bought or given. *(from the design; no question)*
- The capital threshold test is the same for a purchase and a gift. *(CAD-1,
  CAD-3)*
- An asset's cost on the register is the line's cost on the same basis for a
  purchase and a gift. *(CAD-2)*
- An asset that is undone is retired with a reason and its number is not issued
  again. *(CAD-7)*
- A withdrawn gift's assets are retired. *(CAD-8)*

## 7. Tests

- Expense unit: the shared threshold test, both callers, against the CAD-1 and
  CAD-3 examples.
- Expense integration: `register` repeated for the same line returns the same
  numbers; `retire` keeps the number; the next number skips retired ones; each
  writes its audit row.
- Bulk-donation integration: the gift's capital decision and its event in one
  transaction; the drain registers, stamps, and survives a crash between the two;
  a withdrawal settled retires; a bucket change before booking carries through.
- Booking: a gift's asset line books from its own decision with the expense
  database unreachable.
- Flow test: accept a gift, decide one line capital on the gift's page, see it
  book to a fixed-asset account and appear on the register with a link to the
  gift line.

## 8. Not doing

- A page listing the register. The register has none today (only the seed
  page); that is a separate gap.
- Booking depreciation to QuickBooks. The app records the period and the
  fully-depreciated date and books nothing.
- The audit-gap fixes being made elsewhere for the routes in section 1. This
  design removes the copy those gaps are in; it does not patch them.
- Anything under `checkin-app/src/security/`. The route changes this needs ship
  in their own boundary PRs, listed in the migration file.

## Appendix — where this came from

A survey of change-audit gaps found that accepting a gift as capital made three
writes with no audit row. @thpr's reading: capital should be a side decision in
a larger flow, not a flow of its own that recreates records elsewhere. This
document maps both paths and proposes that shape.
