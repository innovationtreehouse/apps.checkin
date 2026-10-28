# Finance view audit

Design for Board ruling B11: the app records who views finance information.

## Problem

The Board has ruled that the app must keep a record of who looks at the
organisation's finance information: expenses, receipts, deposits, donations,
donors, gifts of goods and the matching against the books. Today the app records
who *changes* those records, but only one kind of *look* is recorded: a look at a
donor's name. A Board member or a finance volunteer can open every receipt,
payout and gift in the app and leave no trace. If a question later comes up
about who saw a reimbursement, a donor's gift or a bank deposit, nobody can
answer it.

## Objective

Every time someone views finance records other than their own, the app writes one
row saying who looked, at which records, through which screen, and when. The row
never holds what they saw. The Board can read these rows on the System status
page. Rows are kept with no time limit; nothing deletes them.

## Executive summary

- **What is recorded.** One row per request that returned finance records to
  anyone viewing records other than their own (finance, the Board, operations,
  inventory managers, bucket approvers): the person, the role their view was chosen under, the
  endpoint, the ids of the records returned, how many, and the time. No amounts,
  names, descriptions, search terms or file contents.
- **How.** One flag on the security registry entry, `auditedRead: true`. The
  security handler writes the row before the response leaves, for every view
  except one that reaches only the caller's own rows. No per-route code. A guard test fails the build when a new
  finance read route forgets the flag.
- **What is not recorded.** A person looking at their own receipts. Count badges
  and queue counts, which show numbers and no record. Settings and mapping
  screens (the books map, account lists), which describe how the books are set
  up, not money. Repeated loads of the same records by the same person within a
  fifteen-minute window, which collapse to one row.
- **Who reads it.** The Board, on a new "Finance views" tab on System status.
  Finance does not read it: the people being watched do not read the watch.
- **Retention.** No limit. Rows are never deleted. Log retention has not been
  decided for any of the app's logs, and this one follows that decision when
  it is made.
- **Cost.** About a dozen people hold a view that reaches others' finance
  records. Finance screens
  do not poll on a timer. A busy day is a few hundred rows, about a hundred
  thousand small rows a year.
- **What does not change.** Who may see what. This design adds a record of
  access; it widens and narrows nothing.
- **PRs.** Four, each based on `main`: the table and writer; the handler and
  registry change, alone; the viewer route's registry entry, alone; then the
  viewer itself and the retirement of the per-route donor-read writes.

## Rules this relies on or changes

- `revenue.md`, Procedure: "Only finance and the board can see who gave. Each
  look at a donor is recorded." This design generalises the second sentence to
  all finance records and replaces the per-route donor-read writes that
  implement it today (FV-6).
- `expenses.md`, Procedure: "Being on the Board is enough to view receipt and
  expense data." Unchanged; the log records those views.
- `principles.md`, Accountability: "A trail nobody can read is not a trail."
  The Board-readable tab is what satisfies it.
- `principles.md`, Least privilege: decides who reads the log (FV-4) and what a
  row holds.
- `principles.md`, Fail closed: a view whose audit row cannot be written is
  refused (see "Failure").

Proposed register line, to land with the handler PR (wording for review):

> - Every view of finance records other than a person's own is recorded: who looked,
>   which records, through which screen, and when, never what the records said.
>   A person looking at their own receipts is not recorded, and neither is a
>   count. Only the Board reads the record. [Decision — owner]

It goes in `revenue.md` beside the donor line it replaces, and `expenses.md`
points to it rather than restating it (FV-7).

---

## 1. What counts as viewing finance information

A view of finance information is a successful GET that returns one or more rows
describing money in or out, or a person tied to that money, to a caller whose
chosen view reaches rows other than their own. That covers finance and the
Board, and also the narrower audiences some routes admit: operations and
inventory managers on gifts of goods and the receipt-to-books mapping, and
bucket approvers on the lines they approve.

All of these views are logged, including the ones that show no person. Gift
values, vendors and prices are finance information without the names
attached. Outside finance and the Board, each audience already gets the goods
and amounts with the people removed: the stripper drops every `pii` field
(donor, submitter, person reimbursed) from these views. This design changes
none of it.

| Audience | Screens | Sees | Does not see |
|---|---|---|---|
| Finance, the Board | Every in-scope route | Everything the route returns, including donors, submitters and the person reimbursed | Nothing |
| Operations, inventory managers | Gifts of goods recorded without a receipt, list | The goods (description, quantity, barcode), their value, the donation date, who recorded it | The donor's name or company |
| Inventory managers | Receipt-to-books mapping, list and detail | Vendor, totals, tax and shipping, each line with its price, mapping status | Who submitted the receipt or is reimbursed |
| Bucket approvers | Expenses in their buckets, list and detail, with approvals and sign-offs | Vendor, amounts, lines, approval and sign-off state | The submitter, the person reimbursed, who recorded Board authorization |
| Bucket approvers | Gifts of goods in their buckets | The goods, their value, the date | The donor; the screen carries no donor field |

A change that adds a `pii` grant to one of these audiences widens access and
goes through the boundary rule on its own; the log records the wider view
without further change.

### In scope

Every route below is registered and runs through `handler()` or
`fileHandler()`. All paths are given in full.

| Record kind | Routes |
|---|---|
| Receipts and their files | `GET /api/receipts`, `GET /api/receipts/[id]`, `GET /api/receipts/[id]/file`, `GET /api/receipts/[id]/audit-logs`, `GET /api/receipts/[id]/duplicate-group`, `GET /api/receipts/needs-attention`, `GET /api/receipts/confirmations`, `GET /api/receipts/mail-items`, `GET /api/receipts/mail-items/[id]/file`, `GET /api/receipts/ignored-files` |
| Expenses | `GET /api/expense/expenses`, `GET /api/expense/expenses/[id]`, `GET /api/expense/expenses/[id]/line-item-approvals`, `GET /api/expense/expenses/[id]/signoffs`, `GET /api/expense/expenses/[id]/reimbursee-vendor`, `GET /api/expense/queue`, `GET /api/expense/finance-queue`, `GET /api/expense/expense-holds`, `GET /api/expense/expense-events`, `GET /api/expense/flags`, `GET /api/expense/donated-capital`, `GET /api/expense/received-expense-payloads`, `GET /api/expense/provisional-items` |
| QuickBooks candidates and exclusions | `GET /api/expense/expenses/[id]/qb-candidates`, `GET /api/expense/qb-exclusions`, `GET /api/income/reconciliation/[id]/candidates`, `GET /api/income/qb-exclusions`, `GET /api/donations/disbursement-events/[disbursementId]/qb-candidates`, `GET /api/donations/qb-exclusions` |
| Deposits and store payouts | `GET /api/income/payouts`, `GET /api/income/payouts/[gid]`, `GET /api/income/items`, `GET /api/income/reconciliation` |
| Donations and donors | `GET /api/donations/transactions`, `GET /api/donations/transactions/[id]`, `GET /api/donations/transactions/unassigned`, `GET /api/donations/disbursement-events`, `GET /api/donations/disbursement-holds`, `GET /api/donations/uploaded-files`, `GET /api/donations/uploaded-files/[id]/blob`, `GET /api/donations/comment-rules` |
| Gifts of goods | `GET /api/donations/in-kind/queue`, `GET /api/donations/in-kind/by-bucket`, `GET /api/donations/in-kind/manual`, `GET /api/donations/in-kind/manual/[id]`, `GET /api/donations/in-kind/receipt/[id]` |
| Receipt-to-books mapping | `GET /api/workflow-mapping/receipts`, `GET /api/workflow-mapping/receipts/[id]`, `GET /api/workflow-mapping/audit-log` |
| Membership and program payments | `GET /api/finance-ops/payments`, `GET /api/finance-ops/payment-plans`, `GET /api/finance-ops/membership-payment-plans` (FV-2) |
| Reports | None exist today. Any future finance report route takes the flag; the guard in §1.3 makes it fail the build otherwise. |

The table is the starting set. The authoritative list is the set of registry
entries carrying `auditedRead`, which the guard keeps complete.

### Out of scope, and why

- **Counts.** `GET /api/donations/nav-counts`, `GET /api/receipts/queue-counts`,
  `GET /api/expense/finance-queue/counts`, `GET /api/expense/counts`,
  `GET /api/expense/expenses/count` (a different route from the one before),
  `GET /api/expense/expense-events/count`, `GET /api/income/reconciliation/count`,
  `GET /api/workflow-mapping/receipts/counts`, and the nav todo counts. They return numbers, no record, and they load on every page, so
  logging them would bury the real views. [Decision — deliberate limit]
- **Set-up screens.** The books map, QuickBooks account and class lists, account
  mapping, ownership map, budget buckets and their approvers, and the settings
  routes. They describe how the books are arranged, not money that moved or who
  gave it (FV-1).
- **A person's own records.** `GET /api/receipts/mine`, and the submitter view
  of `GET /api/receipts/[id]`. Looking at your own receipt is not oversight of
  anyone else's money. The handler skips any view that reaches only the
  caller's own rows (§1.1), so a shared route logs its finance view and not its
  submitter view.
- **The reimbursee picker.** `GET /api/receipts/reimbursee-options` lists people
  a submitter can name, at the public tier; it shows no money.
- **Writes.** A POST or PATCH that echoes the changed row is already recorded
  by the library's change audit, which says more than a view row would.

### 1.1 The hook: one flag on the registry entry

`RouteSpec` and `FileRouteSpec` gain one optional field:

```ts
/** A view of others' rows on this route writes a finance-view row (B11). */
auditedRead?: true;
```

A typical entry:

```ts
defineRoute({
  endpoint: 'GET /api/receipts/[id]',
  authorize: 'receipt-submitter',
  envelope: null,
  returns: ['ReceiptView', 'ReceiptLineView'],
  orderedView: SHARED_READ_VIEW,
  auditedRead: true,
});
```

Which views are logged follows from the view's tokens, not from a role list.
The handler logs unless every scoped token in the chosen view is `their_own:`.
So the finance and Board views (`everyones:`) are logged; a bucket approver's
view, scoped to their buckets, is logged; the inventory manager and operations
views on gifts of goods and the mapping are logged; and the submitter view
(`their_own:` only) is not. Deriving it from the tokens means a role added to a
route later is logged without anyone remembering to list it, which a role list
would not do.

Registration rejects the flag on any non-GET endpoint.

### 1.2 Where the handler writes

`handler()` already knows, after the stripper runs, the chosen role and the
stripped bag. When `spec.auditedRead` is set, the chosen view is not
own-rows-only (§1.1), and the stripped bag holds at least one row, it writes the row and only then returns the
response. `fileHandler()` does the same after its per-row scope check passes,
with the one row it is serving: a file route serves exactly one row, so its
`rowCount` is 1 and its record id is that row's `id`, or, where the file row
carries no `id`, the route's `[id]` path parameter. The path parameters are
recorded either way, so every file view names the record it came from.

Choosing the stripped bag over the user function's raw return matters: the log
records what left the server, not what the handler fetched. A row the stripper
removed entirely was not seen.

Record ids come from the stripped bag's top-level rows: every row's `id`, or its
`gid` for store payouts. A row without either is counted but contributes no id.
Path parameters are recorded as well, so a detail view whose row shape lacks an
`id` is still identifiable.

### 1.3 Keeping the list complete

A new test, beside the existing route-auth drift guard, walks every registered
GET route and file route. If its `returns` names a model from a finance library,
it must either carry `auditedRead` or appear in an exemption
list, each exemption with a one-line reason (a count, a set-up screen, a
self-only view). A new finance route that forgets the flag fails the build, as a
new page that forgets the page registry does today.

The finance models are known by source, not from the merged classification
map: each finance library has its own generated classification file
(`generated/receipt-classifications.ts`, `expense-`, `income-`, `donation-`,
`workflow-`) and its own synthetic classification file
(`receiptSyntheticClassifications.ts` and its siblings). The guard takes the
union of those files' model names, plus the checkin models behind the
payment routes (`PaymentQueueRow`, the payment-plan views). A file route is
judged by its `file.model`.

The exemption list is maintained by hand on purpose. A new count or set-up
route is rare, and naming it with a reason is the one moment someone decides
it shows no money.

## 2. What is recorded

One table in the checkin database, `FinanceViewLog`. The handler runs in the
checkin app, and each finance library keeps its own database, so a host table
is the one place every library's views can land in a single write.

| Column | Holds | Tier |
|---|---|---|
| `id` | row id | internal |
| `viewedAt` | when the response was built | internal |
| `actorId` | the viewer's person id | internal |
| `role` | the role the view was chosen under (`isFinance`, `isBoardMember`, …); null only on rows copied from the donor-read audit, which did not record it | internal |
| `endpoint` | the registry key, e.g. `GET /api/receipts/[id]` | internal |
| `params` | the path parameters, e.g. `{"id":"r_123"}` | internal |
| `recordIds` | the ids of the rows returned, as text | internal |
| `rowCount` | how many rows were returned | internal |
| `window` | the fifteen-minute window the view fell in (§5) | internal |
| `viewKey` | a SHA-256 of the endpoint, the path parameters with keys sorted, and the record ids sorted, as hex | internal |

Indexes: `(viewedAt)` for the default listing, `(actorId,
viewedAt)` for "what did this person look at", and a GIN index on `recordIds`
for "who looked at this record". A unique index on `(actorId, viewKey, window)`
collapses repeats (§5). The writer computes `viewKey`; canonicalising the
parameters and ids before hashing is what makes two loads of the same records
produce the same key whatever order they arrived in.

**Never recorded:** field values, amounts, names, descriptions, file bytes, and
the query string. The query string is left out on purpose: a search box carries
whatever the viewer typed, often a donor's or vendor's name, which is content.
A list view is identified by the ids it returned, which is more exact than its
filter anyway.

The viewer's name is not copied into the row. The tab resolves it from the
person id at read time, so a merged or renamed person shows correctly and the
log holds no personal data of its own beyond the id.

### Failure

The write happens before the response is sent, in the request. If it fails, the
request returns a 500 and the records are not shown. This is how the donor-read
audit behaves today, and it follows *fail closed*: a view the Board ruled must
be recorded is not served unrecorded. The cost is that a failure of the log
table blocks finance screens; that failure is visible at once, which is the
point (FV-5).

## 3. Retention

No limit. Rows are kept indefinitely and nothing in this design deletes them.

The app has not decided how long any of its logs are kept, and this log waits
for that decision rather than setting its own. The receipt-file ruling (B19)
governs the files, not the logs, so it does not apply here. When a log
retention period is decided, adding a purge is a small app-code change: the
`(viewedAt)` index already serves it.

A view row outlives the record it names. When a discarded or rejected receipt
is deleted, the view row stays: it holds only an id, and it is then the only
evidence the receipt was looked at.

## 4. Who may read the log, and where

**The Board, and only the Board.** It shows on a new "Finance views" tab on the
System status page, beside the existing Audit Log tab.

The tab lists rows newest first, 50 to a page, and filters by:

- person (who looked);
- record kind (receipts, expenses, payouts, donations, gifts of goods,
  payments), derived from the endpoint;
- a record id ("who looked at this receipt");
- a date range.

Each row reads as a sentence: "Pat Lee (Finance) viewed 3 receipts on the
finance queue, 27 Oct 2026 14:05". A row's record ids link to the record, which
opens under the Board member's own access, so the log grants no access to
anything the reader could not already see.

Finance does not read it. Finance holders are most of the people the log
records; a log readable by the people it watches can be checked by them for
gaps before anyone else looks. Sysadmins do not read it either: the existing
Audit Log tab admits sysadmins for operational forensics, but the finance view
log answers a Board question, and least privilege keeps it with the Board
(FV-4).

Reading the log is not itself logged. The log holds no finance content, so
reading it is not viewing finance information.

## 5. Cost and volume

**Who generates rows.** Only views that reach others' records: finance, the
Board, operations, inventory managers and bucket approvers, which today is
about a dozen people. Submitters, who are the largest group touching receipts, write
nothing.

**Polling.** No finance screen polls on a timer. The only timed poll in the app
is the notifications dot (every 60 seconds), which reads counts and is out of
scope. The finance screens load on navigation and on save; count badges load
with the nav and are out of scope.

**Repeats.** A Board member flicking between two tabs reloads the same list
many times. Each load is the same person, the same endpoint and the same
records. The row's `window` is its view time rounded down to fifteen minutes,
and the insert is `ON CONFLICT DO NOTHING` against the unique index on
`(actorId, viewKey, window)` from §2. One statement, no
read before the write. The first view in each window is recorded with its exact
time; repeats within the window add nothing. A different page of a list returns
different ids and is recorded.

This keeps "when" accurate to fifteen minutes, which is enough for every
question the log answers ("did this person see this record, and roughly when").

**Size.** A generous day is a few hundred rows. A list page carries at most 200
ids, typically 50. At 300 rows a day the table grows by about 110,000 rows and
at most a few tens of megabytes a year. With no retention limit it grows
without bound, but at this rate a decade of rows is well within what one
indexed Postgres table serves.

**Latency.** One indexed insert per audited request, in the same database the
request already uses for its session. A list route that previously made one
library query now also makes one host insert.

## 6. The PR split

The boundary rule says any change to the handler, the registry or the token
grammar ships in its own PR, with only tests, docs and schema annotations
alongside. Each PR below is based on `main`, never stacked on the one before
(the stacking hazard in `AGENTS.md`); each waits for the previous one to merge.

1. **Table and writer (app code, not boundary).** The `FinanceViewLog` model
   with `@sensitivity:internal` on every field, its additive migration, the
   writer function (`recordFinanceView`). Nothing calls
   the writer yet. Additive and safe against old code during the deploy drain.
2. **Handler and registry (boundary, alone).** The `auditedRead` field and its
   registration checks in `core.ts`; the write call in `handler()` and
   `fileHandler()`; the flag on every in-scope registry entry; the guard test of
   §1.3 with its exemption list; contract tests that an audited view writes one
   row, an unlisted role writes none, a repeat in the window writes none, and a
   failed write returns 500. The register line lands here, since this is where
   the behaviour starts.
3. **Viewer registry entry (boundary, alone).** `GET
   /api/system-status/finance-views`, Board only. Inert until the route exists.
4. **Viewer and donor-read retirement (app code).** The route and the System
   status tab; removal of the per-route donor-read writes in the bulk-donation
   library and the receipt glue, now that every route they covered is flagged;
   the `revenue.md` donor line folded into the new one; a one-time script that
   copies the existing donor-read rows into the new log (FV-9). The originals
   stay in the bulk-donation database.

If the owner prefers the donor-read retirement apart from the viewer, step 4
splits into two app-code PRs with no ordering between them.

At merge of the last PR this doc is deleted; the register line is its only
standing rule.

---

## Decisions

All resolved by the owner. IDs are kept so the body's references stay valid.

- **FV-1. Resolved: set-up screens are left out.** The books map, account
  lists, bucket approvers and settings are set-up, not sensitive.
- **FV-2. Resolved: membership and program payments and payment plans are
  included.**
- **FV-3. Resolved: no retention limit.** Rows are kept indefinitely; log
  retention is undecided app-wide, and this log follows that decision.
- **FV-4. Resolved: the Board only reads the log.**
- **FV-5. Resolved: fail closed.** A view whose row cannot be written is
  refused.
- **FV-6. Resolved: the per-route donor-read writes are removed** in PR 4, as
  duplicates of the new log. Their existing rows stay in the bulk-donation
  database.
- **FV-7. Resolved: the rule goes in `revenue.md`, with a pointer from
  `expenses.md`.**
- **FV-8. Resolved: no per-record viewer list.** The Board filters the tab by
  record id.
- **FV-9. Resolved: the existing donor-read rows are copied once into the new
  log** in PR 4, and the originals are kept. The cutover steps are in
  `B11_FINANCE_VIEW_AUDIT-migration.md`.
