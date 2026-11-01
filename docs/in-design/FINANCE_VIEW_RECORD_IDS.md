# Finance view log: record what was viewed, not a guess

Design for making the finance view record (the finance-view rule in
`docs/rules/revenue.md`) name the records each view showed and the screen it
came through. No code changes with this doc.

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
- **in-kind queue and by-bucket:** each row's kind depends on its `source`. The
  grammar needs a kind chosen per row, or the response splits into two keys
  (Q7).

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
| `GET /api/expense/expenses/[id]` | expense ← param `id`; lines: Q2 | ✓ expense; reasons inflate count |
| `GET /api/expense/expenses/[id]/line-item-approvals` | expense ← param `id` | ✗ approval and bucket ids |
| `GET /api/expense/expenses/[id]/signoffs` | expense ← param `id` (decided) | ✗ none |
| `GET /api/expense/expenses/[id]/reimbursee-vendor` | expense ← param `id` | ✗ link-row id; nothing when empty |
| `GET /api/expense/expenses/[id]/qb-candidates` | expense ← param `id`; qb-transaction ← `ExpenseQbCandidateView.id` | ✗ expense missing; nothing when empty |
| `GET /api/expense/finance-queue` | expense ← `expenseId`; receipt ← `receiptId` (§4); query `tab` | ✗ none |
| `GET /api/expense/expense-events` | expense ← `ExpenseEvent.expenseId` | ✗ event and expense ids mixed |
| `GET /api/expense/received-expense-payloads` | receipt ← `receiptId` (Q4) | ✗ payload ids |
| `GET /api/expense/qb-exclusions` | qb-transaction ← `qbTxnId` (Q4) | ✗ exclusion ids |
| `GET /api/expense/donated-capital` | donated-capital-line ← `id` | ✓ |
| `GET /api/expense/provisional-items` | Q5: a catalog proposal, not a finance record | ✗ mixed |
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
| `GET /api/receipts/ignored-files` | Q5: an ignore-list entry, not a finance record | ✗ |
| `GET /api/workflow-mapping/receipts` | workflow-mapping ← `id`; query `state`, `receiptId` | ✓ |
| `GET /api/workflow-mapping/receipts/[id]` | workflow-mapping ← param `id` | ✓ id; helper and line rows inflate |
| `GET /api/workflow-mapping/audit-log` | workflow-mapping ← `receivedReceiptId` (Q3); query `receiptId` | ✗ history-entry ids |
| `GET /api/donations/transactions` | donation ← `id`; query `assigned` | ✓ |
| `GET /api/donations/transactions/unassigned` | donation ← `id` | ✓ |
| `GET /api/donations/transactions/[id]` | donation ← param `id` | ✓ |
| `GET /api/donations/uploaded-files` | donation-file ← `id` | ✓ |
| `GET /api/donations/uploaded-files/[id]/blob` (file) | donation-file ← param `id` | ✓ |
| `GET /api/donations/comment-rules` | Q5: a matching rule, but it carries donor comment text | ✗ rule ids |
| `GET /api/donations/disbursement-holds` | disbursement ← `disbursementId`; donation ← `transactionId` (Q4) | ✗ hold ids |
| `GET /api/donations/disbursement-events` | disbursement ← `disbursementId` (Q4) | ✗ event ids |
| `GET /api/donations/in-kind/manual` | gift-of-goods-manual ← `id` | ✓ |
| `GET /api/donations/in-kind/manual/[id]` | gift-of-goods-manual ← param `id` | ✓ |
| `GET /api/donations/in-kind/receipt/[id]` | gift-of-goods-receipt ← param `id` | ✓ |
| `GET /api/donations/in-kind/queue` | gift of goods, kind by `source` ← `id` (Q7) | ✗ ids collide |
| `GET /api/donations/in-kind/by-bucket` | gift of goods, kind by `source` ← `id` (Q7) | ✗ ids collide |
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
- **`GET /api/income/items` is not logged.** It maps Shopify variants to
  buckets; that mapping is not a finance record.  [Decision — owner]
- **"Payout record" means a payout from Shopify, and nothing else.**
  [Decision — owner]

## Open questions for @thpr

- **Q1. The kind list.** Are the fifteen kinds in "What each route would
  declare" the right list and the right names? Each becomes a label on the
  Board's tab ("viewed 3 expenses", "viewed 1 gift of goods").
- **Q2. Lines inside a record.** Expense detail shows the expense and its lines;
  a bucket approver sees only their buckets' lines. Should the log name only the
  expense (as decided for signoffs), or the lines shown too?
- **Q3. History screens.** `GET /api/receipts/[id]/audit-logs` and
  `GET /api/workflow-mapping/audit-log` show the change history of one receipt or
  mapping. Should the log name only that receipt or mapping, and not each
  history entry?
- **Q4. Bookkeeping rows.** Six routes list a bookkeeping row about a finance
  record: QuickBooks exclusions (expense and income), received expense
  payloads, disbursement holds, disbursement events and income reconciliation.
  Should the log name the finance record each row is about (the QuickBooks
  transaction, the receipt, the disbursement, the payout) instead of the
  bookkeeping row's own id?
- **Q5. Not finance records?** Like the income item mapping, three audited
  routes show something other than a finance record:
  - `GET /api/expense/provisional-items`: proposed catalog items and part-to-bucket mappings;
  - `GET /api/receipts/ignored-files`: the mailbox's list of ignored files;
  - `GET /api/donations/comment-rules`: rules for matching donor comments, which
    carry the donors' comment text.

  Which of these stop being logged?
- **Q6. Empty detail screens.** Opening an expense's reimbursee or QuickBooks
  candidates when there are none logs nothing today. With the expense declared
  from the path, should that view be logged?
- **Q7. Gifts of goods from two tables.** The in-kind queue and by-bucket list
  gifts from two tables. Should the grammar choose the kind per row from
  `source`, or should those routes return the two kinds under two keys?
- **Q8. Log rows written before the change.** Their ids carry no kind, so
  searching for `expense:e_123` will not find them. Should the search also match
  the bare id on rows from before the cutover, or leave old rows to the date and
  person filters?

## Follow-ups outside this design

- `GET /api/receipts/duplicate-queue` is registered and audited but has no route
  or handler. Removing the entry is a boundary decommission of its own.
