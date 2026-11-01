# Finance view log: record what was viewed, not a guess

Design for making the finance view record (the finance-view rule in
`docs/rules/revenue.md`) name the records each view showed and the screen it
came through. No code changes with this doc.

**Status: under discussion, nothing is being built.** Q9 (which fields make a
view a finance view) may change how the design decides what to log. The
route-by-route design below stands only until Q9 is settled.

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
| `GET /api/receipts/[id]/audit-logs` | receipt ← param `id` (Q3) | ✗ history-entry ids |
| `GET /api/receipts/[id]/duplicate-group` | receipt ← param `id`, `members[].id`, `members[].copyOfId`, `dismissed[]` (decided) | ✗ none |
| `GET /api/receipts/duplicate-queue` | registered, but no route or handler exists | — |
| `GET /api/receipts/mail-items` | mail-item ← `id` | ✓ |
| `GET /api/receipts/mail-items/[id]/file` (file) | mail-item ← param `id` | ✓ |
| `GET /api/receipts/ignored-files` | depends on Q9: an ignore-list entry (file hash and reason) | ✗ |
| `GET /api/workflow-mapping/receipts` | workflow-mapping ← `id`; query `state`, `receiptId` | ✓ |
| `GET /api/workflow-mapping/receipts/[id]` | workflow-mapping ← param `id` | ✓ id; helper and line rows inflate |
| `GET /api/workflow-mapping/audit-log` | workflow-mapping ← `receivedReceiptId` (Q3); query `receiptId` | ✗ history-entry ids |
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
   dropping `auditedRead` from `GET /api/income/items`. With its migration for
   the new columns.
2. **App code:** `receiptId` in the finance-queue rows; `financeViewKinds.ts`
   labels and links by kind; the tab shows the path and query.

Until (2) adds `receiptId`, the declared field is absent and an intake row
records nothing, as today.

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
- **Log rows written before the change stay as they are.** Nothing converts
  them, and the search does not match their bare ids.  [Decision — owner]

## Open questions for @thpr

Q2, Q5, Q7 and Q8 are settled or withdrawn; their numbers stay retired.

- **Q1. The kind list.** Each kind is the noun on the Board's tab. For example,
  a row reads "Pat Lee (Finance) viewed 3 **expenses** on the finance queue" or
  "viewed 1 **gift of goods (from a receipt)**". Proposed kinds: expense,
  receipt, mail item, workflow mapping, QuickBooks transaction, donated capital
  line, donation, donation file, disbursement, gift of goods (from a receipt),
  gift of goods (entered by hand), payout, payment exception, payment plan,
  membership payment plan. Are these the right nouns? Q9 may shorten the list.

- **Q3. A receipt's change history.** This is not about the view log itself:
  the view log is only shown on System status → Finance Views.
  Receipts have a separate **change history**: who uploaded a receipt, who
  approved it, and each edited field with its value before and after. Finance
  and the Board read it in a panel on the receipt's page, through
  `GET /api/receipts/[id]/audit-logs`. A row of that history looks like:

  > id 101, receipt r_9, Pat Lee, 3 Oct, changed `totalCents` from 4210 to 4120

  That panel shows dollars and names, so reading it is a finance view. When
  Finance opens receipt r_9's history panel with 3 entries, the view log
  records today: "viewed 3 receipts", ids `101, 102, 103` (the history entries'
  ids, which name no receipt). The options:
  - (a) record "viewed receipt r_9", the receipt whose history was read;
  - (b) record nothing, because the history panel is not itself a finance
    record.

  `GET /api/workflow-mapping/audit-log` is the same panel for a receipt's
  QuickBooks mapping. Which of (a) or (b)?

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

- **Q6. A detail panel with nothing in it.** Expense e_123 has no reimbursee set.
  Finance opens its reimbursee panel
  (`GET /api/expense/expenses/[id]/reimbursee-vendor`), which comes back empty.
  Today nothing is logged, because nothing was returned. The panel sits on
  expense e_123's page and shows no dollars or names. Log "viewed expense
  e_123", or log nothing?

- **Q9. Which fields make a view a finance view.** You said what matters is the
  fields shown, not the screens: dollars or a donor's name make a view a
  finance view, and the views follow from that. The design above instead
  flags each route by hand. Deriving the views from fields would work like
  this: fields carry a mark, and a view is logged when the response sent
  contains a marked field on a record that is not the viewer's own. The
  records named are the rows carrying those fields.

  To get there, the mark needs a list. Candidates from the schema, for you to
  confirm or cut:
  - money amounts: every `…Cents` field (totals, line amounts, payouts,
    deposits, gift values);
  - donor identity: a donor's name, email and address on a donation, and a
    donor's comment text;
  - payee identity: who is reimbursed, and the vendor on an expense;
  - anything else: bank or card details, QuickBooks account names?

  Which fields are on the list? Until this is settled the design does not
  change, and nothing is built.

## Follow-ups outside this design

- `GET /api/receipts/duplicate-queue` is registered and audited but has no route
  or handler. Removing the entry is a boundary decommission of its own.
