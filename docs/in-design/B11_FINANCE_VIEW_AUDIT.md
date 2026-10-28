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

Every time a finance or Board view returns finance records, the app writes one
row saying who looked, at which records, through which screen, and when. The row
never holds what they saw. The Board can read these rows on the System status
page. Rows are kept as long as the approved receipts they could be asked about,
and then deleted.

## Executive summary

- **What is recorded.** One row per request that returned finance records to a
  finance or Board view: the person, the role their view was chosen under, the
  endpoint, the ids of the records returned, how many, and the time. No amounts,
  names, descriptions, search terms or file contents.
- **How.** One flag on the security registry entry, `auditedRead`, listing the
  roles whose views are logged. The security handler writes the row before the
  response leaves. No per-route code. A guard test fails the build when a new
  finance read route forgets the flag.
- **What is not recorded.** A person looking at their own receipts. Count badges
  and queue counts, which show numbers and no record. Settings and mapping
  screens (the books map, account lists), which describe how the books are set
  up, not money. Repeated loads of the same records by the same person within a
  fifteen-minute window, which collapse to one row.
- **Who reads it.** The Board, on a new "Finance views" tab on System status.
  Finance does not read it: the people being watched do not read the watch.
- **Retention.** Each row is kept until seven years after the Form 990 filing
  deadline for the fiscal year the view happened in, the same clock as an
  approved receipt (B19), then deleted by the nightly job.
- **Cost.** About a dozen people hold a finance or Board view. Finance screens
  do not poll on a timer. A busy day is a few hundred rows; the whole retained
  log is under a million small rows.
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
- B19 (Board): approved receipts are kept six years after the year's Form 990
  filing deadline, plus one year; discarded and rejected receipts are deleted
  after one year.

Proposed register line, to land with the handler PR (wording for review):

> - Every finance or Board view of finance records is recorded: who looked,
>   which records, through which screen, and when, never what the records said.
>   A person looking at their own receipts is not recorded, and neither is a
>   count. Only the Board reads the record. [Decision — owner]

It goes in `revenue.md` beside the donor line it replaces, and `expenses.md`
points to it rather than restating it (FV-7).

---

## 1. What counts as viewing finance information

A view of finance information is a successful GET that returns one or more rows
describing money in or out, or a person tied to that money, to a caller whose
chosen view is a finance or Board view.

### In scope

| Record kind | Routes (all registered, all run through `handler()` or `fileHandler()`) |
|---|---|
| Receipts and their files | `GET /api/receipts`, `/[id]`, `/[id]/file`, `/[id]/audit-logs`, `/[id]/duplicate-group`, `/needs-attention`, `/confirmations`, `/mail-items`, `/mail-items/[id]/file`, `/ignored-files`, `/reimbursee-options` |
| Expenses | `GET /api/expense/expenses`, `/[id]`, `/[id]/line-item-approvals`, `/[id]/signoffs`, `/[id]/reimbursee-vendor`, `/queue`, `/finance-queue`, `/expense-holds`, `/expense-events`, `/flags`, `/donated-capital`, `/received-expense-payloads`, `/provisional-items` |
| QuickBooks candidates and exclusions | `GET /api/expense/expenses/[id]/qb-candidates`, `/api/expense/qb-exclusions`, `/api/income/reconciliation/[id]/candidates`, `/api/income/qb-exclusions`, `/api/donations/disbursement-events/[disbursementId]/qb-candidates`, `/api/donations/qb-exclusions` |
| Deposits and store payouts | `GET /api/income/payouts`, `/payouts/[gid]`, `/items`, `/reconciliation` |
| Donations and donors | `GET /api/donations/transactions`, `/[id]`, `/unassigned`, `/disbursement-events`, `/disbursement-holds`, `/uploaded-files`, `/uploaded-files/[id]/blob`, `/comment-rules` |
| Gifts of goods | `GET /api/donations/in-kind/queue`, `/by-bucket`, `/manual`, `/manual/[id]`, `/receipt/[id]` |
| Receipt-to-books mapping | `GET /api/workflow-mapping/receipts`, `/receipts/[id]`, `/audit-log` |
| Membership and program payments | `GET /api/finance-ops/payments`, `/payment-plans`, `/membership-payment-plans` (FV-2) |
| Reports | None exist today. Any future finance report route takes the flag; the guard in §1.3 makes it fail the build otherwise. |

The table is the starting set. The authoritative list is the set of registry
entries carrying `auditedRead`, which the guard keeps complete.

### Out of scope, and why

- **Counts.** `nav-counts`, `queue-counts`, `finance-queue/counts`,
  `expense/counts`, `expenses/count`, `expense-events/count`,
  `reconciliation/count`, `workflow-mapping/receipts/counts`, and the nav todo
  counts. They return numbers, no record, and they load on every page, so
  logging them would bury the real views. [Decision — deliberate limit]
- **Set-up screens.** The books map, QuickBooks account and class lists, account
  mapping, ownership map, budget buckets and their approvers, and the settings
  routes. They describe how the books are arranged, not money that moved or who
  gave it (FV-1).
- **A person's own records.** `GET /api/receipts/mine`, and the submitter view
  of `GET /api/receipts/[id]`. Looking at your own receipt is not oversight of
  anyone else's money. The flag lists roles, so the submitter view of a shared
  route is simply not listed.
- **Writes.** A POST or PATCH that echoes the changed row is already recorded
  by the library's change audit, which says more than a view row would.

### 1.1 The hook: one flag on the registry entry

`RouteSpec` and `FileRouteSpec` gain one optional field:

```ts
/** Views chosen under these roles write a finance-view row (B11). */
auditedRead?: readonly Role[];
```

A typical entry:

```ts
defineRoute({
  endpoint: 'GET /api/receipts/[id]',
  authorize: 'authenticated',
  envelope: null,
  returns: ['ReceiptView'],
  orderedView: RECEIPT_VIEW,
  auditedRead: ['isFinance', 'isBoardMember'],
});
```

Most library registry modules already share a view constant per audience
(`FINANCE_READ_VIEW`, `FINANCE_VIEW`); they gain a matching shared constant,
so the per-entry change is one short line.

Registration rejects an `auditedRead` role that does not appear in the entry's
`orderedView`, so a flag can never name a view the route cannot choose, and
rejects the flag on any non-GET endpoint.

### 1.2 Where the handler writes

`handler()` already knows, after the stripper runs, the chosen role and the
stripped bag. When `spec.auditedRead` includes the chosen role and the stripped
bag holds at least one row, it writes the row and only then returns the
response. `fileHandler()` does the same after its per-row scope check passes,
with the one row it is serving.

Choosing the stripped bag over the user function's raw return matters: the log
records what left the server, not what the handler fetched. A row the stripper
removed entirely was not seen.

Record ids come from the stripped bag's top-level rows: every row's `id`, or its
`gid` for store payouts. A row without either is counted but contributes no id.
Path parameters are recorded as well, so a detail view whose row shape lacks an
`id` is still identifiable.

### 1.3 Keeping the list complete

A new test, beside the existing route-auth drift guard, walks every registered
GET route and file route. If its `returns` names a model from a finance library
(the receipt, expense, income, bulk-donation and workflow-mapping
classifications), it must either carry `auditedRead` or appear in an exemption
list, each exemption with a one-line reason (a count, a set-up screen, a
self-only view). A new finance route that forgets the flag fails the build, as a
new page that forgets the page registry does today.

## 2. What is recorded

One table in the checkin database, `FinanceViewLog`. The handler runs in the
checkin app, and each finance library keeps its own database, so a host table
is the one place every library's views can land in a single write.

| Column | Holds | Tier |
|---|---|---|
| `id` | row id | internal |
| `viewedAt` | when the response was built | internal |
| `actorId` | the viewer's person id | internal |
| `role` | the role the view was chosen under (`isFinance`, `isBoardMember`, …) | internal |
| `endpoint` | the registry key, e.g. `GET /api/receipts/[id]` | internal |
| `params` | the path parameters, e.g. `{"id":"r_123"}` | internal |
| `recordIds` | the ids of the rows returned, as text | internal |
| `rowCount` | how many rows were returned | internal |
| `window` | the fifteen-minute window the view fell in (§5) | internal |

Indexes: `(viewedAt)` for the purge and the default listing, `(actorId,
viewedAt)` for "what did this person look at", and a GIN index on `recordIds`
for "who looked at this record". A unique index on `(actorId, endpoint, params,
recordIdsHash, window)` collapses repeats (§5).

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

Each row is kept until seven years after the Form 990 filing deadline for the
fiscal year the view happened in, then deleted.

That is the B19 clock for approved receipts: six years after the year's Form
990 deadline, plus one. The reasoning for using the same clock is that the
question a view row answers ("who saw this record?") can be asked as long as the
record itself can be examined. The longest-kept finance record is an approved
receipt, so the view log matches it. A shorter period would leave an approved
receipt still inside its audit window with nobody able to say who looked at it.

Rows for records with a shorter life (a discarded or rejected receipt, deleted
after one year) are kept on the same clock, not deleted with the record. Once
the record is gone, the view row is the only evidence it was looked at, and it
holds nothing but an id. This keeps one rule for the whole table and needs no
join to the libraries' databases at purge time.

**Mechanism.** The nightly cron deletes rows whose purge date has passed, in
batches, and writes one system audit row saying how many it removed. The purge
date is computed from `viewedAt` and the organisation's fiscal year end, which
the app does not record today (FV-3).

For a calendar fiscal year the Form 990 deadline is 15 May of the following
year, so a view on any day of 2027 is deleted on 16 May 2035.

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

**Who generates rows.** Only finance and Board views, which today is about a
dozen people. Submitters, who are the largest group touching receipts, write
nothing.

**Polling.** No finance screen polls on a timer. The only timed poll in the app
is the notifications dot (every 60 seconds), which reads counts and is out of
scope. The finance screens load on navigation and on save; count badges load
with the nav and are out of scope.

**Repeats.** A Board member flicking between two tabs reloads the same list
many times. Each load is the same person, the same endpoint and the same
records. The row's `window` is its view time rounded down to fifteen minutes,
and the insert is `ON CONFLICT DO NOTHING` against the unique index on person,
endpoint, parameters, a hash of the record ids, and window. One statement, no
read before the write. The first view in each window is recorded with its exact
time; repeats within the window add nothing. A different page of a list returns
different ids and is recorded.

This keeps "when" accurate to fifteen minutes, which is enough for every
question the log answers ("did this person see this record, and roughly when").

**Size.** A generous day is a few hundred rows. A list page carries at most 200
ids, typically 50. At 300 rows a day for eight years the table holds under a
million rows and a few hundred megabytes at the outside, with the purge holding
it there.

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
   writer function (`recordFinanceView`), and the nightly purge. Nothing calls
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
   the `revenue.md` donor line folded into the new one. Old donor-read rows stay
   in the bulk-donation database until their own retention ends (FV-6).

If the owner prefers the donor-read retirement apart from the viewer, step 4
splits into two app-code PRs with no ordering between them.

At merge of the last PR this doc is deleted; the register line is its only
standing rule.

---

## Open questions

- **FV-1. Are the set-up screens finance information?** The books map, account
  lists, bucket approvers and settings show how the books are arranged, not
  money. *Recommendation:* leave them out. They change rarely, every change is
  already audited, and logging every load of a dropdown list adds rows that
  answer no question. Add one later by setting the flag; no other change.
- **FV-2. Do membership and program payments and payment plans count?** They
  are money, and `revenue.md` already limits them to the Board and finance.
  *Recommendation:* yes, include them. B11 says finance information, and these
  are the household-level money records most likely to be asked about.
- **FV-3. Where does the fiscal year end come from?** The app records none.
  *Recommendation:* a Board setting, defaulting to 31 December, read by the
  purge only. Nothing is purged for eight years, so the setting only has to be
  right before the first purge. With a fiscal year that ends mid-year, the
  calendar default would delete some rows up to six months early, which is why
  it should be confirmed rather than assumed.
- **FV-4. Who reads the log?** *Recommendation:* the Board only, as in §4. The
  alternative, Board and sysadmin as on the Audit Log tab, gives an operator a
  map of which records finance has been working on without a Board reason to
  have it.
- **FV-5. Fail closed or fail open on a write error?** *Recommendation:* fail
  closed, as the donor-read audit does today. Failing open would let the log go
  silent exactly when something is wrong with it, and nobody would know which
  views were missed.
- **FV-6. Retire the per-route donor-read writes?** Once every route they cover
  is flagged, they duplicate the new log in a second database.
  *Recommendation:* retire the writers in PR 4 and keep their existing rows
  until the same retention clock removes them. Nothing is dropped; only the
  duplicate writer stops.
- **FV-7. Which register file holds the rule?** *Recommendation:* `revenue.md`,
  next to the donor line it replaces, with a one-line pointer from
  `expenses.md`. The alternative is `principles.md`, but the rule bites only in
  finance, and §3.3 of the documentation standard keeps a one-domain rule in its
  domain.
- **FV-8. Per-record "who viewed this" on the record itself?** A receipt's page
  could list its viewers. *Recommendation:* no. That shows the watch to finance
  (FV-4), and the Board can already filter the tab by record id.
