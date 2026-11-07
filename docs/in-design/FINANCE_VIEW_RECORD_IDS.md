# Finance view log: record what was viewed, not a guess

Design for making the finance view record (the finance-view rule in
`docs/rules/revenue.md`) name the records each view showed and the screen it
came through. No code changes with this doc.

**Status: under discussion, nothing is being built.** The log records one
entry per page view (Q10 and Q11, decided). Which fields make a view a finance
view is mostly decided (Q9). Narrowing Board ruling B11 to views that link
people to money (Q12) is decided for now, pending the Board's confirmation at
its next meeting; the boundary PR waits for that.

## The unit of logging: a page view (Q10 and Q11, decided)

**The problem.** A page in the app loads its data from several API routes. The
expense page for e_123 calls the expense detail route, then signoffs, line-item
approvals, the reimbursee panel and the QuickBooks candidates. That is five
calls. Each audited route writes its own log row, so one look at one expense
can write up to five rows. The Board wants one entry: "Pat Lee viewed expense
e_123 on the expense page". The routes still decide what is sensitive, but the
entry is the page view.

**What the server can see.** The server sees only API calls. It does not know
which page made a call, or that five calls came from one page load. The
browser has no shared place where API calls go out: pages call `fetch()`
directly, about 200 times across `checkin-app/src`.

**Options.**

- **(a) The browser tags each call with its page view; the server merges.**
  Each page load mints a page-view id. Every API call from that page carries the
  id and the page's path in a header. The server merges every audited call
  carrying the same id into one log row: one page, every record seen on it. A
  call with no tag (a script, a direct API call) still writes its own row, so
  nothing goes unlogged and the fail-closed rule holds. The page path comes from
  the browser, but the records named still come from what the server sent.
  Cost: one global wrapper installed in the app shell that tags every
  same-origin `/api` call, instead of editing 200 call sites.
- **(b) Log per call, and group on the Board's tab.** The log stays as it is,
  and the tab folds rows from the same person within a few seconds into one
  entry. That is a guess again: two pages opened in two tabs fold into one.
- **(c) The page reports its own view.** The page posts one "I showed these
  records" event. A client can skip the post, so a view can go unlogged. This
  breaks the rule that a view whose record cannot be written is refused, so it
  cannot stand alone.

**Decided: (a).** This follows from Q11: a per-page allowlist only makes sense
when the browser tags each call with its page view.

### Can it be fooled?

The page-view id and the page path both come from the browser, so a client can
lie about either. The design makes a lie cost **attribution only, never
coverage**:

- The records named always come from the stripped server responses, never
  from the client.
- Merging only ever adds record ids to the row. It never drops a call's
  records and never skips a write.
- The own-records exclusion (§5) is decided by the server from the records
  themselves, never from the claimed path.
- Leaving the header off produces more rows, not fewer.

What a lie can still do:

- **Reuse one id across pages.** Unrelated views fold into one row under one
  page name, with coarser timing. Example: Pat opens expense e_123, then
  receipt r_9, sending the same id both times; the log shows one entry, "on
  the expense page", naming e_123 and r_9.
- **Claim a different path.** Example: the expense page's calls arrive
  labelled `/finance/review`, so the entry reads "viewed expense e_123 on the
  finance queue". The record is right; the screen is wrong.

Three server-side limits, proposed:

- **Bound to the person.** A page-view id merges only calls from the person who
  first used it. The same id from someone else starts their own row.
- **A short window.** Calls merge only within 30 seconds of the id's first call.
  After that, a reused id starts a new row.
- **One path per id.** Calls merge only when they claim the same page path as
  the id's first call. A call claiming another path starts a new row.

With these, a lie can only merge one person's own calls, made within 30 seconds,
under one page name. What it can still do is put the wrong page name on that
entry. The Q11 allowlist closes that.

**Q11. A per-page allowlist of routes.** @thpr suggested the server keep a map
from each page to the API routes that page may fold into its entry. A call
from a route not on its claimed page's list writes its own row. Example:

| Page | Routes it may fold |
|---|---|
| `/expense/expenses/[id]` | expense detail, signoffs, line-item approvals, reimbursee-vendor, qb-candidates |
| `/finance/review` | finance-queue |

A call to `GET /api/donations/transactions` claiming `/expense/expenses/e_123`
is not on that page's list, so it writes its own row and does not fold into
the expense entry.

- **What it buys over the three limits:** the words "on the X page" become
  trustworthy. A client can no longer fold a donation view into an expense
  entry, or label a finance-queue call as the expense page.
- **What it costs:** every new panel or route a page calls has to be added to
  the map. Until it is, that call logs as a separate row. That is safe (nothing
  goes unlogged), just noisier, and the noise shows that the map is behind.
- **Where it lives:** the page registry (`checkin-app/src/components/pageRegistry.ts`)
  lists only named pages, not dynamic ones such as `/expense/expenses/[id]`
  (it says so at its top and in `REGISTRY_EXCLUDED`). So the map needs a
  declaration of its own beside the registry, or the registry has to grow
  dynamic pages. The map decides what gets merged in the log, so it is a
  boundary file either way.

**Decided: keep the allowlist,** as a boundary declaration beside the page
registry, together with the three limits.

**Effect on the other questions.** Under (a), the panels on a record's page fold
into that page's single entry:

- Q3 (a receipt's change-history panel) is retired. The receipt page's entry
  already names r_9.
- Q6 (an empty reimbursee panel) is retired. The expense page's entry already
  names e_123.


## The problem

The rule says the record holds "who looked, which records, through which screen,
and when". Today the handler guesses two of those:

- **Which records.** On an `auditedRead` route, `handler()` records
  `row.id ?? row.payoutGid` for every top-level row of every key in the stripped
  response (`checkin-app/src/security/handler.ts`). Nothing checks that the field
  is the finance record's id, or that the row is a record at all.
- **Which screen.** The row stores the registry key (`GET /api/expense/expenses/[id]`)
  and the path params, never the query string. The Board's tab then guesses the
  record kind from the path prefix (`checkin-app/src/lib/finance/financeViewKinds.ts`),
  so everything under `/api/income` reads as "payout records".

An audit of every audited route (below) found the guess right on about half.
The rest fail in five ways:

| Failure | Routes | Effect |
|---|---|---|
| No `id` on the row | finance-queue, signoffs, duplicate-group, payment-plans | No record named. |
| The row's own bookkeeping id, not the record's | expense and income qb-exclusions, received-expense-payloads, disbursement-holds, disbursement-events, income reconciliation, both audit-log routes | The id names a bookkeeping row the Board cannot search for. |
| Helper rows mixed in | expense detail (`ExpenseQueueReason`), line-item-approvals (buckets), expense-events (slim expenses), provisional-items, workflow detail, payout detail (balance transactions), payment-plans (`BoardSettings` as id `"1"`) | Wrong ids in the list, and `rowCount` inflated. |
| Ids from two tables in one list | in-kind queue, in-kind by-bucket (`source` + `id`) | The same number names two different gifts. |
| Nothing returned, so nothing logged | reimbursee-vendor and qb-candidates when empty | Opening an expense leaves no row, though the path names it. |

Two more consequences:

- **Repeats collapse wrongly.** The log keeps one row per person, view key and
  fifteen-minute window, and the view key hashes the endpoint, path params and
  record ids. A route that records no ids has the same key on every load, so
  views of different finance-queue tabs within fifteen minutes collapse into
  one row, and the later tabs are lost.
- **Own records slip in.** Confirmations shows a Board member their own
  reimbursements beside everyone else's, and logs all of them. The rule says a
  person's own receipts are not recorded.

## The design

### 1. Each audited route declares what it shows

`auditedRead: true` becomes a declaration of the records the route shows:

```ts
auditedRead: {
  records: [
    { kind: 'expense', key: 'FinanceQueueRow', id: 'expenseId' },
    { kind: 'receipt', key: 'FinanceQueueRow', id: 'receiptId' },
  ],
  query: ['tab'],
},
```

- `kind` comes from a closed list of record kinds (§3).
- `key` is the bag key whose rows hold the records. A row of any other key is
  never recorded or counted.
- `id` is a field on the row, a nested path (`members[].id`), a list of fields
  joined into one id (`['programId', 'personId']`), or a path param
  (`{ param: 'id' }`). A row whose field is null contributes nothing for that
  kind.
- `query` lists the query parameters that pick the screen (§2).

Ids are still read from the **stripped** response, so the log names only what
left the server.

**Checked when the server starts.** Registration throws when:

- an audited route has no `records`;
- a declared field is not classified on its model;
- a declared field's tier is not visible to every role in the route's
  `orderedView` that reaches others' rows. If it were not, that role's views
  would log nothing, silently.

The guard test that keeps the audited list complete stays as it is.

### 2. Log the exact request

Each row stores:

- the registry key, as now, for grouping;
- the **concrete path** (`GET /api/expense/expenses/e_123/signoffs`);
- the **declared query parameters only**, for example `{ "tab": "holds" }`.

Undeclared query parameters stay out. The reason is in the original B11 design:
a search box carries whatever the viewer typed, often a donor's or vendor's
name, which is content. The audit found no audited route that reads free text
today; the allowlist keeps it that way when one is added. The declared query
parameters go into the view key, so two tabs are two views.

### 3. Store kind-qualified record ids

`recordIds` holds `kind:id` strings: `expense:e_123`, `receipt:r_9`,
`payment-plan:12:345`. That:

- tells two tables' ids apart (`gift-of-goods-receipt:5`, `gift-of-goods-manual:5`);
- lets the tab label and link each id from its kind, with no path-prefix guess;
- keeps "who looked at this expense" one indexed `has` query on `expense:e_123`.

`rowCount` becomes the number of distinct records named, not the number of
top-level rows.

The kind list lives in `core.ts` (a boundary file). Its labels and page links
live in `financeViewKinds.ts` (app code), which drops its prefix table.

### 4. Response changes the declarations need

- **finance-queue:** a row for a receipt with no expense yet carries neither
  `expenseId` nor the receipt id (`rowsOf` in
  `packages/expense/src/services/financeQueueService.ts`). It needs `receiptId`
  added to `FinanceQueueRow`, with a classification entry.
- **in-kind queue and by-bucket:** these lists mix gifts of goods from two
  tables. A gift that came in on a receipt is row 5 of `InKindDonation`; a gift
  entered by hand is row 5 of `ManualInKindDonation`. Both reach the list as
  `id: 5`, told apart only by the row's `source` field (`receipt` or `manual`),
  so today the log records `5` for either. The declaration reads `source` and
  records `gift-of-goods-receipt:5` or `gift-of-goods-manual:5`. This is a
  mechanism detail, not a question.

### 5. Own records

On a route that shows a person their own records beside others', the handler
drops the caller's own records from the ids before writing. A view that showed
only their own writes nothing. This needs each declared kind to name its owner
field where it has one (`uploadedByUserId` on a receipt). Today only
confirmations needs it.

## What each route would declare

Kinds proposed in §3: `expense`, `receipt`, `mail-item`, `workflow-mapping`,
`qb-transaction`, `donated-capital-line`, `donation`, `donation-file`,
`disbursement`, `gift-of-goods-receipt`, `gift-of-goods-manual`, `payout`,
`payment-exception`, `payment-plan`, `membership-payment-plan`. The final list
is Q1.

"Today" is what the current handler records: ✓ the right ids, ✗ wrong or none.

| Route | Records shown → declared id | Today |
|---|---|---|
| `GET /api/expense/expenses` | expense ← `Expense.id`; query `view`, `active` | ✓ |
| `GET /api/expense/queue` | expense ← `Expense.id`; query `view` | ✓ |
| `GET /api/expense/expenses/[id]` | expense ← param `id`, not its lines (decided) | ✓ expense; reasons inflate count |
| `GET /api/expense/expenses/[id]/line-item-approvals` | expense ← param `id` | ✗ approval and bucket ids |
| `GET /api/expense/expenses/[id]/signoffs` | expense ← param `id` (decided) | ✗ none |
| `GET /api/expense/expenses/[id]/reimbursee-vendor` | expense ← param `id` | ✗ link-row id; nothing when empty |
| `GET /api/expense/expenses/[id]/qb-candidates` | expense ← param `id`; qb-transaction ← `ExpenseQbCandidateView.id` | ✗ expense missing; nothing when empty |
| `GET /api/expense/finance-queue` | expense ← `expenseId`; receipt ← `receiptId` (§4); query `tab` | ✗ none |
| `GET /api/expense/expense-events` | expense ← `ExpenseEvent.expenseId` | ✗ event and expense ids mixed |
| `GET /api/expense/received-expense-payloads` | receipt ← `receiptId` (Q4) | ✗ payload ids |
| `GET /api/expense/qb-exclusions` | qb-transaction ← `qbTxnId` (Q4) | ✗ exclusion ids |
| `GET /api/expense/donated-capital` | donated-capital-line ← `id` | ✓ |
| `GET /api/expense/provisional-items` | not logged: catalog, not finance (decided) | ✗ mixed |
| `GET /api/receipts` | receipt ← `id`; query `state`, `pushed` | ✓ |
| `GET /api/receipts/needs-attention` | receipt ← `id` | ✓ |
| `GET /api/receipts/confirmations` | receipt ← `id`, minus own (§5) | ✓ ids, but logs own |
| `GET /api/receipts/[id]` | receipt ← param `id` | ✓ |
| `GET /api/receipts/[id]/file` (file) | receipt ← param `id` | ✓ |
| `GET /api/receipts/[id]/audit-logs` | receipt ← param `id`; folds into the receipt page's entry | ✗ history-entry ids |
| `GET /api/receipts/[id]/duplicate-group` | receipt ← param `id`, `members[].id`, `members[].copyOfId`, `dismissed[]` (decided) | ✗ none |
| `GET /api/receipts/duplicate-queue` | registered, but no route or handler exists | — |
| `GET /api/receipts/mail-items` | mail-item ← `id` | ✓ |
| `GET /api/receipts/mail-items/[id]/file` (file) | mail-item ← param `id` | ✓ |
| `GET /api/receipts/ignored-files` | depends on Q9: an ignore-list entry (file hash and reason) | ✗ |
| `GET /api/workflow-mapping/receipts` | workflow-mapping ← `id`; query `state`, `receiptId` | ✓ |
| `GET /api/workflow-mapping/receipts/[id]` | workflow-mapping ← param `id` | ✓ id; helper and line rows inflate |
| `GET /api/workflow-mapping/audit-log` | workflow-mapping ← `receivedReceiptId`; query `receiptId`; folds into its page's entry | ✗ history-entry ids |
| `GET /api/donations/transactions` | donation ← `id`; query `assigned` | ✓ |
| `GET /api/donations/transactions/unassigned` | donation ← `id` | ✓ |
| `GET /api/donations/transactions/[id]` | donation ← param `id` | ✓ |
| `GET /api/donations/uploaded-files` | donation-file ← `id` | ✓ |
| `GET /api/donations/uploaded-files/[id]/blob` (file) | donation-file ← param `id` | ✓ |
| `GET /api/donations/comment-rules` | depends on Q9: a matching rule that carries donor comment text | ✗ rule ids |
| `GET /api/donations/disbursement-holds` | disbursement ← `disbursementId`; donation ← `transactionId` (Q4) | ✗ hold ids |
| `GET /api/donations/disbursement-events` | disbursement ← `disbursementId` (Q4) | ✗ event ids |
| `GET /api/donations/in-kind/manual` | gift-of-goods-manual ← `id` | ✓ |
| `GET /api/donations/in-kind/manual/[id]` | gift-of-goods-manual ← param `id` | ✓ |
| `GET /api/donations/in-kind/receipt/[id]` | gift-of-goods-receipt ← param `id` | ✓ |
| `GET /api/donations/in-kind/queue` | gift of goods, kind by `source` ← `id` (§4) | ✗ ids collide |
| `GET /api/donations/in-kind/by-bucket` | gift of goods, kind by `source` ← `id` (§4) | ✗ ids collide |
| `GET /api/income/payouts` | payout ← `payoutGid` | ✓ |
| `GET /api/income/payouts/[gid]` | payout ← param `gid` | ✓ payout; reconciliation id and balance rows mixed in |
| `GET /api/income/reconciliation` | payout or disbursement by `source` ← `payoutGid` (Q4) | ✗ reconciliation ids |
| `GET /api/income/reconciliation/[id]/candidates` | qb-transaction ← `IncomeQbDepositView.id` | ✓ deposits; the payout only in the path |
| `GET /api/income/qb-exclusions` | qb-transaction ← `qbTxnId` (Q4) | ✗ exclusion ids |
| `GET /api/income/items` | not audited (decided) | — |
| `GET /api/finance-ops/payments` | payment-exception ← `id` | ✓ |
| `GET /api/finance-ops/payment-plans` | payment-plan ← `['programId','personId']` (decided) | ✗ none; `BoardSettings` as `"1"` |
| `GET /api/finance-ops/membership-payment-plans` | membership-payment-plan ← `id` | ✓ |

## The PR split

1. **Boundary:** the declaration grammar and the start-up checks in `core.ts`;
   the handler and file handler reading declarations; the concrete path and
   declared query on the log row; kind-qualified ids; every audited registry
   entry's declaration; `receiptId` in `FinanceQueueRow`'s classification;
   dropping `auditedRead` from `GET /api/income/items`. No migration (see
   below).
2. **App code:** `receiptId` in the finance-queue rows; `financeViewKinds.ts`
   labels and links by kind; the tab shows the path and query.

Until (2) adds `receiptId`, the declared field is absent and an intake row
records nothing, as today.

**The migration ships first, on its own.** The boundary isolation workflow
(`.github/workflows/security-boundary-isolation.yml`) does not accept
`prisma/migrations/` as a companion of a boundary change; only a whole-entry
decommission may carry one. So any new log columns land first in an app-code
PR: an additive migration plus the writer changes that fill the columns, as
B11's first PR (#2659) did. The order is:

1. App code: the additive migration and the writer.
2. Boundary: the items in (1) above, with no migration.
3. App code: the items in (2) above.

**The register rewording lands with the boundary PR,** since the boundary PR is
what narrows the log (Q12). The boundary PR **waits for the Board's
confirmation** of that narrowing. If the Board says no, the field marks stay,
and views of amounts with no person keep being logged: the mark then adds to
the declared records, and does not replace them.

## Decided

- **Payment plans record `programId:personId`.** One id per pending request
  shown.  [Decision — owner]
- **The duplicate review records everything it displays:** each member's `id`
  and `copyOfId`, each id in `dismissed`, and the receipt in the path.
  [Decision — owner]
- **Signoffs record the expense in the path, not its lines.**  [Decision — owner]
- **Expense detail records the expense, not its lines.** The lines always belong
  to that expense, so naming the expense says what was seen.  [Decision — owner]
- **`GET /api/income/items` is not logged.** It maps Shopify variants to
  buckets; that mapping is not a finance record.  [Decision — owner]
- **Catalog items and mappings are not logged.** They are inventory, not finance
  information. This covers `GET /api/expense/provisional-items`.  [Decision — owner]
- **"Payout record" means a payout from Shopify, and nothing else.**
  [Decision — owner]
- **QuickBooks account names are not on the list.** The sensitive part is
  linking people to money; an account name is neither.  [Decision — owner]
- **The starting list of fields that link a person to money stands:** every
  `…Cents` amount; a donor's name, email, address and comment text; and the
  person reimbursed and the vendor on an expense.  [Decision — owner]
- **One log entry per page view (Q10 (a)).** The browser tags each API call
  with a page-view id and the page path; the server merges one person's calls
  carrying that id into one row, within 30 seconds and under one path.
  Untagged calls write their own rows.  [Decision — owner]
- **A per-page allowlist of routes (Q11).** A boundary declaration beside the
  page registry lists the routes each page may fold into its entry. A call from
  a route not on its claimed page's list writes its own row.  [Decision — owner]
- **Fields that link a person to money carry a mark,** and a view is logged
  when the response sent contains a marked field on a record that is not the
  viewer's own (Q9). The marked fields beyond the starting list:  [Decision — owner]
  - **The submitter:** `Receipt.uploadedByUserId` and `Expense.submitterId`.
  - **The cardholder:** no field names one today; the submitter of a
    card-charge expense covers it. Any cardholder field added later carries the
    mark.
  - **The Shopify buyer:** `ShopOrder.customerName` and `customerEmail`, and
    `PaymentQueueRow.familyName` and `familyEmail` as the same buyer.
  - **Refunds, as purchases:** a refund links to a person through its order,
    so a refund view that shows the buyer is logged the same way as the
    purchase.
  - **Every payment plan,** including membership payment plans, which carry no
    amount. On a plan or request record the request fields themselves carry the
    mark: `isPaymentPlanRequested` and `scholarshipRequestKind` on both
    `ProgramParticipant` and `OrgMembershipProcess`.
  - **Scholarships and financial aid:** on `ProgramParticipant`, the
    scholarship hold-ledger fields as well: `inventoryHeldAt` (a seat held for
    a request), `paymentPlanDeniedAt` and `seatTakenWithoutSaleAt` (a seat
    given without a sale), per `docs/architecture/PROGRAM_CAPACITY_AND_SCHOLARSHIPS.md`.
  - **Matched gifts, employer names included:** `Transaction.companyName` and
    `matchAmountCents`.
  - **Every image and stored receipt:** the file fields of a receipt and of a
    mail item carry the mark, so serving one to anyone other than its owner is
    always logged.
- **B11 narrows to views that link people to money (Q12).** A view that shows
  amounts with no person in it stops being logged. That covers:
  - the payouts list (`GET /api/income/payouts`): amounts and dates, no people;
  - gifts of goods shown to operations or inventory managers without the donor
    (`GET /api/donations/in-kind/manual` under their no-donor view);
  - a bucket approver's expense lines, without the submitter or reimbursee
    (`GET /api/expense/expenses` under the approver view).

  [Decision — owner, pending Board confirmation at its next meeting]

  Draft wording for the `docs/rules/revenue.md` register line, for review only
  (`revenue.md` is unchanged until the boundary PR):

  > - Every view that links a person to money is recorded, other than a person's
  >   view of their own: a donor, a buyer, a submitter, a person reimbursed, or
  >   a person asking for a payment plan or a scholarship, seen beside a gift,
  >   an amount or the request. The record holds who looked, which records, on
  >   which page, and when, never what the records said. A view of amounts with
  >   no person in it is not recorded, and neither is a count. Only the Board
  >   reads the record.  [Decision — owner; Board ruling B11, narrowed]
- **Log rows written before the change stay as they are.** Nothing converts
  them, and the search does not match their bare ids.  [Decision — owner]

## Open questions for @thpr

Q2, Q3, Q5, Q6, Q7, Q8, Q10, Q11 and Q12 are settled or retired; their numbers stay retired.

- **Q1. The kind list.** Each kind is the noun on the Board's tab. For example,
  a row reads "Pat Lee (Finance) viewed 3 **expenses** on the finance queue" or
  "viewed 1 **gift of goods (from a receipt)**". Proposed kinds: expense,
  receipt, mail item, workflow mapping, QuickBooks transaction, donated capital
  line, donation, donation file, disbursement, gift of goods (from a receipt),
  gift of goods (entered by hand), payout, payment exception, payment plan,
  membership payment plan. Are these the right nouns? Q9 may shorten the list.

- **Q4. Rows that point at a finance record.** Some screens list rows whose
  own id is just a list entry, and the finance record sits in another field.
  Example, Income → QuickBooks exclusions (`GET /api/income/qb-exclusions`),
  the list of QuickBooks deposits finance said never to match to a payout:

  > id 7, qbTxnId "4412", reason "owner's personal deposit"

  Today the log records `7`, the exclusion list's own row number. Nobody can
  search for 7: finance and QuickBooks know the deposit as 4412. Proposed: record
  QuickBooks transaction 4412.

  The same shape on five more screens:

  | Screen | Row today logs | Proposed to log |
  |---|---|---|
  | Expense QuickBooks exclusions | the exclusion's row id | the QuickBooks transaction (`qbTxnId`) |
  | Received expense payloads | the payload's row id | the receipt it came from (`receiptId`) |
  | Disbursement holds | the hold's row id | the disbursement (`disbursementId`) and the donation (`transactionId`) |
  | Disbursement events | the event's row id | the disbursement (`disbursementId`) |
  | Income reconciliation | the reconciliation's row id | the payout or disbursement (`payoutGid`) |

  Log the record each row points at, as proposed?

- **Q9. Which fields make a view a finance view: what is left.** The rule and
  most of the list are decided (see Decided). Three items are left to confirm:
  - **Company donors.** `donorCompanyName` on `InKindDonation` (bulk-donation)
    and on `Receipt` (receipt). Example: "Acme gave goods worth $300". It names
    a donor beside a gift's value. Marked?
  - **Donation upload files.** The Benevity CSV files
    (`GET /api/donations/uploaded-files/[id]/blob`) carry donor names and
    amounts, but they are not images or receipts. Is the file field marked,
    like receipt files?
  - **Approvers and reviewers** (`approvedByUserId`, `decidedByUserId`,
    `reviewedByUserId`, `boardAuthorizedByUserId`). These name who acted on a
    record, not who paid or was paid. Example: "Lee approved Sam's $42.10
    expense". Marked, or left off?

## Follow-ups outside this design

- `GET /api/receipts/duplicate-queue` is registered and audited but has no route
  or handler. Removing the entry is a boundary decommission of its own.
