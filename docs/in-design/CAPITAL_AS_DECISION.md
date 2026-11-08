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
did it. A decision is taken once, when the record is final, and the app never
undoes it.

## Executive summary

- **For finance.** A gift's capital decision is taken on the gift, after it is
  accepted, in the same two steps as a purchase: designate, then period and
  owner. Both run one implementation of the review. The separate Donated
  Equipment page goes. A purchase's capital review keeps its place but cannot be
  sent back. The decision never changes; a mistake is cleaned up by hand.
- **For the register.** It gains one link per asset to the line that made it,
  the expense line or the gift line, and loses the copied list. Capital is
  decided only once a record can no longer be withdrawn or sent back, so the app
  never undoes an asset and a number is never freed.
- **For booking.** A gift books its asset lines from the decision stored on its
  own lines. It no longer asks the expense side at booking time.
- **Same rules both ways.** One threshold test, one cost basis and one
  account-type rule serve both paths, through the same code. A gift meets the
  thresholds as a purchase does, finance decides every line of a record over
  one, and an asset's cost is what its line books at: its price with its share
  of tax, shipping and discount (CAD-1 to CAD-3, CAD-15, settled). A capital
  line always books to a fixed-asset account, bought or given (CAD-11,
  settled).
- **Only forks are designed away.** Of the copies between libraries on these
  paths, the capital-line copy is a fork: the expense line's review steps
  rerun on it through other code. The donor, the gift's money and a purchase's
  lines are hand-offs and keep their shape (section 1.4).
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

### 1.3 The donor, at receipt upload

A receipt marked as a gift of goods carries its donor's names. The receipt
library keeps them on the receipt and sends them to bulk-donation, which keeps
its own copy on the gift.

| Step | Where | Writes | Audit |
|---|---|---|---|
| Upload or the in-kind toggle stores the donor and marks it to send | `POST /api/receipts/upload` and `PUT /api/receipts/[id]/in-kind` → `receipt/src/services/receiptService.ts:884,1357` | `Receipt.donor*`, `donorSync = pending`, `donorSyncSeq` + 1 | `uploaded` / `in_kind_updated` |
| The donor is sent, with its sequence number | `sendDonorSync`, `receipt/src/lib/donor-sync.ts:18` → port `donorSink.recordInKindDonor` → `recordDonor`, `bulk-donation/src/services/inKindService.ts:102` | the gift's `donor*`, `donorRecordedAt`, `donorReplacedAt` when it differs | receiving side: `IN_KIND_DONOR_RECORDED`. Sending side: **only a failure**, `donor_sync_failed` |
| The receipt is marked sent, only if nothing changed during the call | `donor-sync.ts:46-50` | `donorSync = synced` | **none** |
| A send still pending is retried | `resendDonorSync`, `receipt/src/services/catchUp.ts:203` | as above | as above |
| The in-kind mark is cleared | the same send → `withdrawInKind` → `withdraw`, `inKindService.ts:130` | deletes the gift, or flags a withdrawal | `IN_KIND_WITHDRAWN` / `IN_KIND_WITHDRAWN_AFTER_MONEY` |
| Finance settles a withdrawal | `settle`, `inKindService.ts:155` | clears the **gift's** donor | `IN_KIND_WITHDRAWAL_SETTLED` |

The receipt edits the donor only while the receipt is editable; once it is
finalized, nothing on the receipt side changes the donor again, and nothing
flows from the gift back into the receipt's donor fields. The receipt still
holds its copy afterwards, and finance's receipt view shows it.

### 1.4 Each copy between libraries: hand-off or fork

@thpr's test: a copy that moves a record to its next owner, with nothing coming
back, is a **hand-off**, and acceptable if the transfer is audited and atomic or
recoverable. A copy after which the same steps run in two flows through
different code is a **fork**, and is the thing to design away.

| Copy | From → to | Verdict | Evidence |
|---|---|---|---|
| A gift's donor | receipt → bulk-donation | **Hand-off** | The decision, conflict checks, warnings and donor letter run only on the gift (`inKindAcceptService.ts`); the receipt only captures and sends. Nothing comes back. Recoverable: the sequence number drops stale sends and the catch-up step resends. Audited on arrival. |
| A gift's money and lines | finalized receipt → bulk-donation | **Hand-off** | `ingestInKind`, `bulk-donation/src/inKind.ts:20`. The receipt is read-only once finalized; the gift owns the value from then on. A resend with different values is flagged, never merged (`inKindService.ts:40-80`). Audited on arrival (`IN_KIND_MONEY_RECEIVED`). Only the decision's outcome is read back, for the receipt pages (`giftOutcomes`, `inKind.ts:81`): a read, not a copy. |
| A purchase's lines | finalized receipt → expense | **Hand-off** | The expense is created once, keyed by the receipt's id (`expense/src/services/intakeService.ts:168-190`), and everything after runs on the expense. Its audit and recovery are outside this design and not checked here. |
| A gift's lines for capital review (`DonatedCapitalLine`) | bulk-donation → expense | **Fork** | The steps after the copy are steps the expense line already has, run through other code; and the result flows back to the gift twice (whether it still waits, and which lines are assets). Table below. |
| An asset on the register (`CapitalAsset`) | the line → the register | **Hand-off in shape, minted by a fork** | A register row is the asset's next owner, and for a purchase nothing comes back. But two loops mint it, differently (below), and for a gift the result is read back at booking (B10). The row stays; the second loop goes. |
| A gift line's account | bulk-donation asks expense's account rules | Neither: a call, nothing stored | `resolveDonatedPartAccounts`, through the host. It shares the rule matcher but filters it differently for capital (B6), which the shared test in Option A settles. |

**The capital fork, step by step.**

| Step | Purchased line | Donated line (after the copy) | Differs how |
|---|---|---|---|
| Threshold test | `classifyCapital` on the whole expense, `expense/src/lib/financial-flow.ts:107` | `classifyCapital` per line, `donatedCapitalService.ts:46-48` | B4, B5 |
| Who is offered for review | every line, `capitalService.ts:73-76` | lines over the threshold only | B11 |
| Designation | `submitCapitalReview`, `capitalService.ts:63` | `reviewDonatedLine`, `donatedCapitalService.ts:87` | one step against two (B11) |
| Period and owner | `setDepreciationCycle`, `capitalService.ts:118` | the same call as the designation | — |
| Bucket check | `requireLiveBuckets`, shared | `requireLiveBuckets`, shared | the same |
| Minting | loop at `capitalService.ts:155-177` | loop at `donatedCapitalService.ts:112-131` | unit cost, date source, idempotency (count check against a 409) (B5) |
| Undo | `clearStepsAfterOwnerApproval`, `signoff-facts.ts:288` | none | B1, B2, B7 |
| Audit | a row per line, `ExpenseAuditLog` | one org row holding the request | B12 |
| Account at booking | `matchingRules`, `account-rules.ts:17` | `donatedPartAccount`, `account-rules.ts:27` | B6 |

Option A designs away this fork and the second minting loop, and only these.
The hand-offs keep their shape and are not part of
this design.

## 2. Bugs found

Each with where it shows. Line numbers are at `main` 7734c351e.

| # | What goes wrong | Evidence |
|---|---|---|
| B1 | **A withdrawn gift keeps its capital lines and assets.** Unreachable in practice, since nothing reaches the withdrawal-after-money state (B13); listed because the code models it. Withdrawal and its settlement touch only the gift. The copied lines are not filtered by the gift's state, so an unreviewed copy stays on the Donated Equipment page and can still be reviewed and minted; assets already minted stay on the register. A purchase undone clears its assets. | `withdraw` and `settle`, `bulk-donation/src/services/inKindService.ts:130,155`; `listDonatedCapital` and `giftsAwaitingCapitalReview`, `donatedCapitalService.ts:54,74` filter only `isCapital: null`; contrast `signoff-facts.ts:296-316` |
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
| B13 | **Gifts carry a withdrawal-after-money state nothing can reach.** A gift is flagged withdrawn after its money, finance settles it, and settling clears the gift's donor. But the receipt holds its money back until the donor sync has landed, so donations already has the final in-kind state and refuses any older call in flight; and the in-kind mark can change only before the receipt is finalized, which is when the money is sent. No path reaches the state, and so a gift never drops its donor. The flag, the settle action, its queue reason and the rule behind them are dead weight, and are to be removed (CAD-8). | `pushReceipt`, `receipt/src/lib/receipt-flow.ts:134-147`; `setInKind`, `receiptService.ts:1340-1344`; `withdraw` and `settle`, `inKindService.ts:130,155`; `waitingOn` `withdrawal`, `inKindAcceptService.ts:295` |

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

### Option A — decide once, on the line, when the record is final (recommended)

**The principle.** Capital is decided once, after the record can no longer be
withdrawn or sent back, and never changes afterwards. Nothing the app does then
undoes it; a mistake is cleaned up by hand (CAD-6). That removes every undo
path, so there is nothing to retire, nothing to reissue and no capital state
machine of its own. Capital is a few fields on the line, and the record's own
flow is the only machine.

**Where each record becomes final.**

- **A gift: once accepted.** The accept is taken once and never reverses
  (`decide`, `inKindAcceptService.ts:463`). A withdrawal after the money
  arrived is modelled, but nothing reaches it (B13): the in-kind mark changes
  only while the receipt is editable (`receiptService.ts:1340-1344`), the money
  is sent only once the receipt is finalized, a final state
  (`receipt/src/workflows/receipt.machine.ts:105`), and only after the donor
  sync has landed, so an older withdrawal still in flight is refused
  (`pushReceipt`, `receipt-flow.ts:134-147`; `claimSyncMark`,
  `inKindService.ts:89`).
- **An expense: once its owner approvals are terminal and its reimbursee is
  known.** After owner approval, the only step that sends an expense back is
  finance naming a reimbursee who was unknown (`signoffService.ts:224-243`,
  through `clearFrom`, `signoff-facts.ts:341`). The rules already stop
  approvals until the reimbursee is known, so this should not reach a capital
  step; the design makes it impossible: the capital step does not open while
  the reimbursee is unknown, and the `APPROVAL_REOPENED` edges out of
  `capital_review` and `set_depreciation_cycle` go
  (`expense/src/workflows/expense.machine.ts:56-72`). The capital part of
  `clearStepsAfterOwnerApproval` then has nothing to clear, and goes, with the
  deletion behind B7.

**On the line.** Both kinds of line carry the same fields; the expense line
already has the first three:

| Field | Meaning |
|---|---|
| `isCapital` | null until finance designates the line; then true or false |
| `depreciationYears` | set in the second step, capital lines only |
| `capitalBucketId` | the owner, set in the second step (the expense line's `capitalOwnerId`) |
| `capitalDecidedByUserId`, `capitalDecidedAt` | who designated and when |

What a record waits on is read from its lines, the same way for both: it waits
on designation while a line it offered has no `isCapital`, and on the period
while a capital line has no `depreciationYears`. The expense keeps its existing
`capital_review` and `set_depreciation_cycle` states for that, and they must
never disagree with its lines: the review module's `afterStep` is the only
code that moves an expense out of either state, and it checks, before
committing, that the state the expense lands in is what its lines say it waits
on. A mismatch is a bug and rolls the step back. A gift has no state of its
own for this; its "waiting on capital" is read from its lines. Whether the record needed review
at all is the threshold test, run once when it becomes final and stored on the
record (`Expense` takes it as its state; the gift gains `capitalReviewNeeded`).

**Thresholds.** One pure test in the expense library, used by both flows, with
the settings read through the existing settings port:

```ts
capitalReviewNeeded(
  record: { totalCents: number; lines: { unitCostCents: number }[] },
  settings: CapitalThresholds,
): boolean
```

The record's total against the total threshold, each unit's cost against the
unit threshold (CAD-1); a unit's cost carries its share of tax, shipping and
discount (CAD-2, CAD-15), so it is the line's booked amount (`lineAmount`,
`expense/src/qb-write.ts:11`) split across its units. When it is true, finance
decides every line (CAD-3).

**Review: the purchase's two steps, reused whole.** A gift takes the same two
steps a purchase does (CAD-5): designate each line, then set each capital
line's period and owner. Its steps come after the accept (CAD-4), on the gift's
own page, and any finance holder may take them, as for a purchase.

*Why today's functions cannot simply be called for a gift.* `submitCapitalReview`
and `setDepreciationCycle` (`expense/src/services/capitalService.ts:63,118`)
are tied to the expense in four places: they load the expense and check its
state; they write `ExpenseLineItem`; they write `ExpenseAuditLog` keyed by the
expense; and they advance the expense and drain it to QuickBooks. The rest says
nothing about expenses: every line must be answered, the owner bucket must be
live, only capital lines take a period, a capital line is registered once.

*So that logic moves out once and both call it.* The expense library gains one
module holding the two steps, written against a small store:

```ts
interface CapitalLineStore {
  lines(): Promise<CapitalLine[]>;                        // the record's lines and unit costs
  save(line: CapitalLine, before: CapitalLine): Promise<void>; // the line and its audit row
  afterStep(step: "designated" | "period_set"): Promise<void>; // expense: advance its state, checked against its lines; gift: nothing
}
designate(store, actor, input): Promise<void>;
setPeriod(store, actor, input, register: RegisterCall): Promise<void>;
```

- The expense binds the store to `ExpenseLineItem`, `ExpenseAuditLog` and its
  state advance, inside its transaction, and registers in the same transaction,
  as today.
- bulk-donation binds it to the gift lines and `WorkflowEvent`
  (`IN_KIND_CAPITAL_DESIGNATED`, `IN_KIND_CAPITAL_PERIOD_SET`) inside the gift's
  transaction. The host passes the module in, as it passes the account rules
  today. Two new routes, `…/[id]/capital-review` and
  `…/[id]/set-depreciation-cycle`, take the purchase routes' input unchanged.

One implementation of the review; the paths cannot fork again.

**Register.** Assets are only ever added. The expense library exposes:

```ts
interface CapitalRegister {
  /** Mints one asset per unit for the line; a repeat for the same line returns the same numbers. */
  register(orgId: string, source: AssetSource, units: AssetUnit[]): Promise<string[]>;
  /** A backfilled line's historical assets: links the line to seeded rows, one per unit; mints nothing. */
  link(orgId: string, source: AssetSource, seededAssetNumbers: string[]): Promise<void>;
}
type AssetSource =
  | { kind: "expense_line"; lineItemId: number }
  | { kind: "gift_line"; giftSource: "receipt" | "manual"; giftId: number; giftLineId: number };
interface AssetUnit { costCents: number; acquisitionDate: string | null; depreciationYears: number; description: string }
```

`CapitalAsset` gains `sourceKind`, the three gift source columns and
`unitIndex`, with a plain unique index on (org, source, unit index). That index
makes `register` repeatable. Asset numbers are physical labels and are never
reused (CAD-7).

The next number comes from a stored high-water mark, `CapitalAssetSequence`,
one row per org holding the highest number ever issued. Each mint takes the
next number from it and raises it in the same transaction; the row lock also
serialises concurrent mints, which the full-register scan in `nextItfaSeq`
(`capital-register.ts:40`) does not. Seeding a historical number above the mark
raises it too; `link` issues no number and leaves it alone. The mark starts at
the highest number on the register; production holds none yet. The audit log is
never an input.

- The expense registers inside its period step's transaction: atomic.
- The gift's period step commits on the gift's side; the in-kind drain then
  calls `register` and stamps the gift line's `registeredAt`. A crash between
  the two is safe: the next run gets the same numbers. This is a hand-off, the
  line's capital facts going to the register, with nothing coming back to the
  gift but the stamp. The gift does not book until every capital line is
  stamped: an asset has its number before it goes to QuickBooks, as a
  purchase's does (CAD-10).

**Booking.** The gift's journal entry reads `isCapital` from its own lines.
`assetLineIds` and the cross-database read at post time go (B10). A capital
line, bought or given, takes its account only from a rule marked capital, which
holds only a fixed-asset account; when no such rule covers it, it waits for
finance (CAD-11). The purchase side drops the unmarked rules from a capital
line's match, as `donatedPartAccount` already does (`account-rules.ts:29`), so
both use one matcher.

**Audit.** Each library audits its own write in the transaction that makes it:

| Write | Row |
|---|---|
| A gift line's designation and period | `IN_KIND_CAPITAL_DESIGNATED`, `IN_KIND_CAPITAL_PERIOD_SET` on the gift, per line |
| A gift's registration stamp | `IN_KIND_CAPITAL_REGISTERED`, naming the asset numbers |
| Each asset minted, either flow | `ExpenseOrgAuditLog` `capital_asset_registered`: number, source link, cost |
| An expense line's designation and period | unchanged |

**Library boundaries.** bulk-donation owns the gift's decision; expense owns
the thresholds, the review module, the account rules and the register. The
cross-library calls are reads of settings and the idempotent `register`, behind
the existing `InKindCapital` port, reshaped. Nothing is copied.

**What it fixes.**

| Bug | How |
|---|---|
| B1 | Capital is decided only once a gift is final, and nothing reaches the withdrawal state (B13, CAD-8) |
| B2 | Nothing to redo: the decision is taken once, when the record is final; a mistake is cleaned up by hand, as for a purchase (CAD-6) |
| B3 | The bucket is on the gift |
| B4, B5, B11 | One threshold test, one cost basis, one review implementation |
| B7 | No path deletes or frees an asset number |
| B9 | The drain retries registration; no hand re-accept |
| B10 | The decision is on the gift line |
| B12 | Every write audited |
| B6 | A capital line matches only rules marked capital, bought or given (CAD-11) |
| B8 | A backfilled line only links to seeded numbers, never mints (CAD-12, CAD-16) |

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

Not chosen (CAD-9). Once capital is decided once and the review is one module,
a separate library buys nothing: it would split the purchase's atomic step
across two databases to house code expense already owns.

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

Option A. Capital is decided once, on the line, after the record can no
longer be withdrawn or sent back, through one review implementation; the
register is reached through a link and only ever grows. It keeps the purchase
path atomic and fixes every bug found. Every question that blocks building is
settled. Removing the unreachable withdrawal state (CAD-8) is a separate PR.
The cutover is in `CAPITAL_AS_DECISION-migration.md`.

## 5. Owner questions

All sixteen are settled (5.1). Numbers are fixed; a settled question keeps its
number.

### 5.1 Settled

| # | Answer (@thpr) | What it changes |
|---|---|---|
| CAD-1 | A gift follows the same threshold rules as a purchase: the **total** threshold is compared with the gift's total, as with the receipt's total on a purchase. | B4's per-line comparison goes. Six $450 chairs as six lines, $2,700 in all, go to review, as the same purchase would. |
| CAD-2 | Both tax and shipping are included in an asset's cost, for purchases and gifts alike. | The purchase side changes: its register cost and the unit price compared with the unit threshold now carry the line's share of tax and shipping, as a gift's already do. The $1,000 table with $80 tax and $50 shipping is registered at $1,130 whether bought or given (B5). Discount is CAD-15, settled the same way. |
| CAD-3 | Gifts and purchases act identically; no new flow. Once a record is over a threshold, finance decides **every** line, as for a purchase today. | B11's "only over-threshold lines" goes. A $3,000 gift of a $2,800 laser and a $200 lens kit: finance decides both lines and may register the kit with the laser. The gift's review calls the expense library's review code; it is not reimplemented. |
| CAD-4 | After accept: the gift's capital decision is its own step, on the gift's page. | Accept stays one act. The capital step is bookkeeping, so any finance holder may take it, as classifying a signed-off purchase is; the accept's conflict rule does not carry over. |
| CAD-5 | Like a purchase: two steps, designate, then period and owner. Reuse the purchase's review wholesale. | The review logic is lifted out of the expense services into one module both paths call (section 3, "Review"); the gift does not get its own. |
| CAD-6 | No. A capital decision never changes after the record books; any mistake is cleaned up by hand. Leave it that way. | Same for both paths. The app never retires or re-registers. |
| CAD-7 | Asset numbers are physical labels and are never reused, whatever the design. And capital is not decided before the record can no longer be withdrawn. | No number is ever issued twice: the next number comes from a stored high-water mark that only rises (B7). Under this design nothing is undone, so no number is freed. Capital steps open only once a gift is accepted or an expense can no longer be sent back; the expense loses its send-back edges out of the capital steps, and the asset deletion behind B7 goes. |
| CAD-8 | Yes: remove the withdrawal-after-money state. | The flag, finance's settle action, the queue's `withdrawal` reason and the `revenue.md` rule behind them go, in a PR of their own outside this design. B1 and B13 go with them. |
| CAD-9 | No separate library. | The register, thresholds and review module stay in the expense library; Option B is dropped. |
| CAD-10 | A capital line needs its number before it goes to QuickBooks. | A gift does not book until each capital line's assets are registered and stamped, as a purchase's are minted before its entry. |
| CAD-11 | Any capital is capital: its account is an asset, not an expense. | A capital line never books to an expense account. On both paths it takes only a rule marked capital, which holds only a fixed-asset account, and waits for finance when none covers it. B6 goes. The CNC router marked capital waits for finance instead of booking to "Tools expense". |
| CAD-12 | For historical assets, the numbers in QuickBooks are the labels on the items and must not change. | The seeded numbers win. A backfilled expense never mints a new number for an asset already seeded: finance links the line to its seeded asset in the period step, and `register` attaches the line to that row instead of minting. Backfilled expenses store no QuickBooks entry id (`expense-qb-processor.ts:320` skips posting), so the link is finance's choice, not a match. The line with no seeded asset is CAD-16. Production has no capital records, so there are no existing duplicates to sort out. |
| CAD-13 | The two sections in 5.2, as worded. | They go into `docs/conventions.md` in their own PR. |
| CAD-14 | Withdrawn: a gift cannot drop its donor. | The only place a gift loses its donor is settling a withdrawal after its money, which nothing reaches (B13). What remains is whether to remove that state, CAD-8. |
| CAD-15 | Yes: the discount is included too. | An asset's cost is exactly what its line books at, price plus its share of tax and shipping less its share of discount, split across its units. The $1,000 table with $80 tax, $50 shipping and $100 off is registered at $1,030, bought or given, and the register agrees with the fixed-asset account to the cent. |
| CAD-16 | Option B: a backfilled line is only linked, never given a new number. | The period step for a backfilled expense takes a seeded number for each unit of each capital line and refuses without them; it has no path that mints. An old item with no label (the 2023 drill press) is given its number on the existing seed page first, then linked. Every number for an old item comes in through the seed. The seed page shows the next free number, so finance does not have to guess one. |

### 5.2 Conventions (CAD-13)

Agreed wording for `docs/conventions.md`, added in its own PR:

```markdown
## One process, one implementation

- **A step that happens in two places is one piece of code both call.** When
  the same decision, check or sequence of steps is needed by two libraries, two
  kinds of record or two routes, it is written once and both call it. A copy, a
  near-copy or a second implementation "for our side" is a fork: the two drift,
  and each fix lands in only one of them.
- **A record crosses into another library only to change owner.** Handing a
  record to the library that takes the next step is fine when nothing flows
  back and the hand-over is audited and either atomic or retried. Copying it so
  another library can run the same steps on its own copy is the fork above.
- **Where the domain says two things are treated the same, they run the same
  code.** "The same rule" kept true by two implementations is a rule waiting to
  diverge.

The failure is slow. Each copy is correct the day it is written; the defect is
the later fix that reaches one of them.

## A simple machine with a known risk beats a complete one nobody can read

- **Whether a step can be undone depends on what undoing it costs, and where.**
  - **A bad state that lives entirely in the app, the app must give a way out
    of.** Nobody can repair it by hand without editing the database, so the
    software owes a path back: an undo, or a reset that returns the record to a
    known starting point and has it go through again.
  - **A decision whose effects are outside the app may be declared
    irreversible.** Once it has reached the books, a physical label or another
    party, unwinding it in the app would mean modelling every outside effect
    to keep them in step. Past that point the app says the decision is final,
    and a mistake is cleaned up by hand. That costs a person some work, and it
    keeps the machine readable. The point is chosen, stated and the same
    everywhere the decision is taken.
- **Take a decision as late as it can be taken, after the things that could
  reverse it.** A decision taken before its record settles needs machinery to
  unwind it when the record moves; one taken after needs none.
- **An edge case the design does not handle is an accepted, written-down risk,
  not a branch.** Record how it could happen, what it costs when it does, and
  how it is cleaned up by hand. Do not add a state, flag or route whose only
  purpose is a case that rarely or never happens.
- **A state nothing can reach is removed.** Code for an unreachable case is not
  insurance; it is a second account of the system that every reader has to
  disprove.

The failure is unreadability. A machine that covers everything is one nobody
can hold in their head, and the bugs live in the transitions nobody traced.
```

## 6. Rules this design would establish

Each is settled and goes into `docs/rules/expenses.md` when the work lands. The
two conventions in 5.2 go into `docs/conventions.md`.

One existing rule changes. The Spending sign-off rule "When an expense goes
back to an earlier step, every later step's result is cleared too … the
capital review, the depreciation cycle and its assets" loses its capital part:
an expense can no longer go back once its capital steps open (CAD-7), so there
is nothing of capital to clear. Its signatures and QuickBooks parts stand.

- A capital decision is recorded on the line it is about, by finance, with who
  and when, whether the line is bought or given. *(from the design; no question)*
- A gift of goods meets the capital thresholds as a purchase does: the gift's
  total against the total threshold, each unit's cost against the unit
  threshold; once a record is over a threshold, finance decides every line.
  *(CAD-1, CAD-3, settled)*
- A gift's capital decision is a step after its accept, which any finance
  holder may take, in the same two steps as a purchase. *(CAD-4, CAD-5, settled)*
- A capital decision never changes after its record books, bought or given; a
  mistake found after booking is cleaned up by hand. *(CAD-6, settled)*
- An asset's cost, on the register and in the unit threshold test, is what its
  line books at: its price with its share of tax, shipping and discount,
  whether bought or given. *(CAD-2, CAD-15, settled)*
- Capital is decided only after the record can no longer be withdrawn or sent
  back: a gift once accepted, an expense once its owner approvals are terminal
  and its reimbursee is known. The app never undoes an asset. *(CAD-7, settled)*
- An asset number is a physical label: it is never issued to a second asset.
  *(CAD-7, settled)*
- A capital line has its asset number before its record goes to QuickBooks,
  bought or given. *(CAD-10, settled)*
- A capital line books only to a fixed-asset account, bought or given; with no
  rule marked capital to give it one, it waits for finance. *(CAD-11, settled)*
- A historical asset keeps the number it carries in QuickBooks, which is its
  label; the app never gives it another. *(CAD-12, settled)*
- A backfilled purchase's capital line is only linked to seeded asset numbers,
  never given a new one; an old item with no number is first given one on the
  seed page. *(CAD-16, settled)*

## 7. Tests

- Expense unit: the shared threshold test, both callers, against the CAD-1,
  CAD-2 and CAD-3 examples: the six chairs, the $1,130 table and the laser with
  its lens kit, each giving the same answer bought or given.
- Expense integration: `register` repeated for the same line returns the same
  numbers and writes its audit row once; the high-water mark rises with each
  mint and with a higher seeded number, and two concurrent mints get different
  numbers; `afterStep` refuses a state its lines disagree with, and for every
  reachable expense state the lines agree; the capital steps refuse to open while
  the reimbursee is unknown; naming a reimbursee never sends an expense back
  out of a capital step.
- Bulk-donation integration: each capital step and its events in one
  transaction; the drain registers, stamps, and survives a crash between the
  two; a gift with an unstamped capital line does not book.
- Booking: a gift's asset line books from its own decision with the expense
  database unreachable.
- Model check before building: the gift's register-then-stamp under crash and
  retry, the one place a duplicate asset number could be minted.
- Flow test: accept a gift, decide one line capital on the gift's page, see it
  book to a fixed-asset account and appear on the register with a link to the
  gift line.

## 8. Not doing

- A page listing the register. The register has none today (only the seed
  page); that is a separate gap.
- Removing the withdrawal-after-money state (CAD-8). Settled, and done in its
  own PR.
- Booking depreciation to QuickBooks. The app records the period and the
  fully-depreciated date and books nothing.
- The audit-gap fixes being made elsewhere for the routes in section 1. This
  design removes the copy those gaps are in; it does not patch them.
- The hand-offs in section 1.4: the donor, the gift's money and lines, and a
  purchase's lines. They keep their shape.
- Anything under `checkin-app/src/security/`. The route changes this needs ship
  in their own boundary PRs, listed in the migration file.

## Appendix — where this came from

A survey of change-audit gaps found that accepting a gift as capital made three
writes with no audit row. @thpr's reading: capital should be a side decision in
a larger flow, not a flow of its own that recreates records elsewhere. This
document maps both paths and proposes that shape.
