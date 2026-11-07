# Finance view log: record what was viewed, not a guess

Design for making the finance view record (the finance-view rule in
`docs/rules/revenue.md`) say exactly what each look at finance information
showed: who looked, on which page, which records, and which sensitive fields
of them. No code changes with this doc.

**Status: one question is open, Q17's second half.** Five routes logged today
show no money or person, so "B11 is not narrowed" needs a way to keep them
logged. Nothing is being built.

## The problem

The rule says the record holds "who looked, which records, through which
screen, and when". Today the handler guesses two of those:

- **Which records.** On a route flagged `auditedRead: true`, `handler()` records
  `row.id ?? row.payoutGid` for every top-level row of every key in the
  stripped response (`checkin-app/src/security/handler.ts`). Nothing checks that
  the field is the finance record's id, or that the row is a record at all.
- **Which screen.** The row stores the API route's registry key
  (`GET /api/expense/expenses/[id]`) and its path params, and no query string.
  The Board's tab then guesses a noun from the path prefix
  (`checkin-app/src/lib/finance/financeViewKinds.ts`), so everything under
  `/api/income` reads as "payout records".

An audit of every audited route found the guess right on about half. The rest
fail in five ways:

| Failure | Example | Effect |
|---|---|---|
| No `id` on the row | finance-queue rows carry `expenseId` | No record named. |
| The row's own bookkeeping id | an income QuickBooks exclusion `id 7, qbTxnId "4412"` logs `7` | The id names a list entry nobody can search for. |
| Helper rows mixed in | payment-plans sends `BoardSettings`, logged as record `"1"` | Wrong ids, inflated count. |
| Ids from two tables in one list | the in-kind queue's `id: 5` is either `InKindDonation` 5 or `ManualInKindDonation` 5 | One number names two gifts. |
| Nothing returned, nothing logged | an expense's empty reimbursee panel | The page was seen; no row. |

It is also per API call, not per page: the expense page makes about five
audited calls, so one look at one expense can write up to five rows.

## The design

### 1. What makes a view a finance view: marked fields

Sensitive finance fields carry a mark: every amount, and the people and
companies tied to money (Q9 and Q15, decided; the field list is under Decided).
A view is logged when the response, **after the stripper has run**, carries a
marked field on a record that is not the viewer's own. The `auditedRead` flag
on each route is no longer what decides logging: a new route that sends a
marked field is logged with nothing to remember.

A route that shows finance records but sends no marked field is not logged.
Nine routes audited today are in that position; see "Routes the marks alone
would stop logging" and Q17.

- **Where the mark lives.** A schema annotation beside `@sensitivity` on each
  field, for example `/// @moneyLink` (the name is settled in the boundary
  PR). It goes in each library's `schema.prisma`, and in the hand-authored
  synthetic classification files for view models. The generator
  (`checkin-app/scripts/security-generator.js`) carries the mark into the
  generated classifications the handler reads. `packages/s-ingest-core` runs
  the same generator, so `ShopOrder` is marked the same way.
- **Stored files.** A receipt image, a mail item's file and a donation upload
  file hold names and amounts inside their bytes, where no field can be seen.
  Their file fields carry the mark, so serving one to anyone other than its
  owner is always logged.
- **Own records.** A record that belongs to the viewer is left out (the rule's
  "other than a person's own"). The server decides this from the record's owner
  field (`uploadedByUserId` on a receipt), never from anything the browser
  says. A view that showed only the viewer's own records writes nothing. Today
  this matters on the confirmations list, which shows a Board member their own
  reimbursements beside everyone else's.
- **Fail closed.** A view whose log row cannot be written is refused, as now.

### 2. Which records a view names

Each record is named `Model:id`: the schema model's name and the record's id.
Examples: `Expense:e_123`, `Receipt:r_9`, `InKindDonation:5`,
`ProgramParticipant:12:345`. There is no hand-kept list of nouns (Q1, decided).

By default a record is the row that carries the marked field, named by its own
model and `id`. A route declares its records only where that default is wrong:

- **The row is a view model.** `FinanceQueueRow.expenseId` names an `Expense`.
  A view model is not a stored model, so the declaration names the model the id
  belongs to.
- **The row points at another record (Q4, decided).** A QuickBooks exclusion
  names `QuickBooks.Transaction` `qbTxnId`, not its own `id`.
- **The id is several fields.** A payment plan is `programId` + `personId`.
- **The row's table depends on a field.** An in-kind row is `InKindDonation` or
  `ManualInKindDonation` by its `source`.
- **The record is in the path or nested.** The duplicate review names each
  member's `id` and `copyOfId`, each id in `dismissed`, and the receipt in the
  path.

The declaration sits on the route's registry entry:

```ts
financeView: {
  records: [
    { key: 'FinanceQueueRow', id: 'expenseId', model: 'Expense' },
    { key: 'FinanceQueueRow', id: 'receiptId', model: 'Receipt' },
  ],
  query: ['tab'],
},
```

- `key` is the bag key whose rows hold the records.
- `id` is a field, a nested path (`members[].id`), a list of fields joined into
  one id (`['programId', 'personId']`), or a path param (`{ param: 'id' }`).
- `model` names the model the id belongs to: a model in the classifications,
  or one of the outside names below.
- `query` lists the query parameters that pick the screen (§4).

**Checked when the server starts.** Registration throws when:

- a route can send a marked field on rows with no `id` and has no declaration;
- a declared field is not classified on its model;
- a declared `model` is neither in the classifications nor on the list of outside names;
- a declared id is not visible to every role in the route's `orderedView` that
  can see the marked field. If it were not, that role's views would name no
  record, silently.

Ids are read from the stripped response, so the log names only what left the
server.

Records that live only in another system are named by that system and the
record's type (Q14, decided): `QuickBooks.Transaction:4412` and
`Benevity.Disbursement:BEN-889`. A transaction has one name on every screen, so
a search for it finds every view. These outside names are a short fixed list
(two today) beside the declaration grammar, and a declared `model` may name one
of them as well as a schema model.

### 3. Which marked fields were sent

Each record in an entry lists the names of the marked fields the viewer was
sent, never their values (Q13, decided). Example: Finance opening expense
e_123 is sent `submitterId`, `reimburseePersonId` and `receiptTotalCents`. A
bucket approver opening the same expense is sent only `receiptTotalCents`. The
entry tells the two apart without anyone working it out from the role. Values
stay out: the rule says "never what the records said". The Board sees the data
itself by following the record's link, under its own access.

### 4. One entry per page view

The log records one entry per page view, not per API call (Q10 (a) and Q11,
decided).

- **The browser tags each call.** Each page load mints a page-view id. Every API
  call from that page carries the id and the page's path in a header. A single
  wrapper installed in the app shell tags every same-origin `/api` call, so
  none of the roughly 200 `fetch()` call sites change.
- **The server merges.** The audited calls carrying one page-view id merge into
  one row: the page, and every record and marked field seen on it. Merging only
  ever adds records and field names to the row. It never drops a call's
  records, and it never skips a write.
- **Untagged calls write their own rows.** A call with no header (a script, a
  direct API call) writes its own row, naming the API path in place of a page.
  Leaving the header off produces more rows, never fewer.
- **The API calls are kept.** The row lists each merged call's registry key,
  concrete path (`GET /api/expense/expenses/e_123/signoffs`) and declared query
  parameters (`{ "tab": "holds" }`). Undeclared query parameters stay out: a
  search box carries whatever the viewer typed, often a donor's or vendor's
  name, which is content.

**Limits on merging.** The page-view id and the page path come from the browser,
so a client can lie about them. A lie may cost the page name or the timing,
never which records were seen:

- **Bound to the person.** An id merges only calls from the person who first
  used it.
- **A short window.** Calls merge only within 30 seconds of the id's first call.
  After that, a reused id starts a new row.
- **One path per id.** Calls merge only when they claim the same page path as
  the id's first call.
- **A per-page allowlist (Q11).** A map from each page to the API routes it may
  fold into its entry:

  | Page | Routes it may fold |
  |---|---|
  | `/expense/expenses/[id]` | expense detail, signoffs, line-item approvals, reimbursee-vendor, qb-candidates |
  | `/finance/review` | finance-queue |

  A call from a route not on its claimed page's list writes its own row. So
  "on /expense/expenses/e_123" can be trusted: no client can fold a donation
  view into an expense entry. The cost is that each new panel must be added to
  the map, and until it is, the panel logs as a row of its own. That is noisy
  but never unlogged.

  The map decides what the log merges, so it is a boundary file. The isolation
  workflow treats `checkin-app/src/security/*` as the boundary, so the map lives
  there (`checkin-app/src/security/pageViewFolds.ts`). It covers the dynamic pages
  that the page registry (`checkin-app/src/components/pageRegistry.ts`) does not
  list.

A page's panels fold into its one entry. The receipt page's entry names r_9
whether or not its change-history panel was opened. The expense page's entry
names e_123 even when its reimbursee panel is empty.

### 5. The log row

| Column | Holds |
|---|---|
| `viewedAt`, `actorId`, `role` | as now |
| `pagePath` | the claimed page path, such as `/expense/expenses/e_123`; null on an untagged row |
| `pageViewId` | the browser's page-view id; null on an untagged row |
| `calls` | each merged call's registry key, concrete path and declared query |
| `records` | each record as `{ ref: "Expense:e_123", fields: ["submitterId", "receiptTotalCents"] }` |
| `recordIds` | the `ref`s alone, as text, for the GIN index ("who looked at Expense:e_123") |
| `recordCount` | the number of distinct records |
| `window`, `viewKey` | the repeat collapse (below) |

**Repeats.** An untagged row collapses repeats as now: one row per person, view
key and fifteen-minute window. Its view key hashes the calls, the record refs
**and their field names**. So a view that later shows the submitter of a record
first seen with only its amount is a new view, and is not swallowed by the
earlier one. The cost is more rows when the same records are seen through
different fields.

A page-view row is keyed by person and page-view id, and the merge adds to it.
A reload is a new page load, with a new id, so it is a new row. Collapsing
identical page loads within the window is not done, because a row is complete
only after its 30 seconds have passed (Q16, decided).

Rows written before the change stay as they are (decided).

### 6. The Board's tab

Each entry reads as the exact information:

> Pat Lee (Finance) viewed Expense:e_123 (submitterId, reimburseePersonId,
> receiptTotalCents), Receipt:r_9 (receiptTotalCents) on
> /expense/expenses/e_123, 6 Nov 2026 14:05

- Each `Model:id` links to that record's page where the app has one
  (`Expense` → `/expense/expenses/<id>`), and is shown plain otherwise.
  `financeViewKinds.ts` becomes this model-to-page link map, and drops its
  prefix table and nouns.
- The field names follow each record, in brackets, as plain text.
- An untagged row shows the API path where a page would be, such as "via
  GET /api/expense/finance-queue?tab=holds".
- The record search matches `recordIds`, as now.

## Records each route names

Most routes name each row by its own model and `id`, and need no declaration.
These are the ones that do. Whether a route is logged at all follows from the
marked fields it sends.

| Route | Records named |
|---|---|
| `GET /api/expense/finance-queue` | `Expense` ← `expenseId`; `Receipt` ← `receiptId`; query `tab` |
| `GET /api/expense/expenses/[id]` and its panels | `Expense` ← param `id`, not its lines (decided) |
| `GET /api/expense/expense-events` | `Expense` ← `ExpenseEvent.expenseId` |
| `GET /api/expense/received-expense-payloads` | `Receipt` ← `receiptId` (Q4) |
| `GET /api/expense/qb-exclusions`, `GET /api/income/qb-exclusions` | `QuickBooks.Transaction` ← `qbTxnId` (Q4) |
| `GET /api/expense/expenses/[id]/qb-candidates`, `GET /api/income/reconciliation/[id]/candidates` | `QuickBooks.Transaction` ← the candidate's `id` |
| `GET /api/expense/donated-capital` | `DonatedCapitalLine` ← `id` (a view model) |
| `GET /api/receipts/[id]/duplicate-group` | `Receipt` ← param `id`, `members[].id`, `members[].copyOfId`, `dismissed[]` (decided) |
| `GET /api/receipts`, needs-attention, confirmations, `[id]` | `Receipt` ← `id` (view models of `Receipt`) |
| `GET /api/workflow-mapping/receipts`, `[id]`, audit-log | `ReceivedReceipt` ← `id`, or ← `receivedReceiptId` on the audit log |
| `GET /api/donations/disbursement-holds` | `Benevity.Disbursement` ← `disbursementId`; `Transaction` ← `transactionId` (Q4) |
| `GET /api/donations/disbursement-events` | `Benevity.Disbursement` ← `disbursementId` (Q4) |
| `GET /api/donations/in-kind/queue`, by-bucket | `InKindDonation` or `ManualInKindDonation` by `source` ← `id` |
| `GET /api/donations/in-kind/receipt/[id]`, `manual/[id]` | `InKindDonation` / `ManualInKindDonation` ← param `id` |
| `GET /api/income/payouts`, `payouts/[gid]` | `ShopPayout` ← `payoutGid`, or ← param `gid` |
| `GET /api/income/reconciliation` | `ShopPayout` or `Benevity.Disbursement` by `source` ← `payoutGid` (Q4) |
| `GET /api/finance-ops/payments` | `PaymentException` ← `id` (a view model) |
| `GET /api/finance-ops/payment-plans` | `ProgramParticipant` ← `['programId','personId']` (decided) |
| file routes (receipt file, mail-item file, donation upload) | the file's record ← param `id` |

Not logged, by decision: `GET /api/income/items` (an item-to-bucket mapping)
and `GET /api/expense/provisional-items` (catalog), whatever marks they carry.

The finance-queue's intake rows need a response change. A row for a receipt
with no expense yet carries neither `expenseId` nor the receipt id (`rowsOf` in
`packages/expense/src/services/financeQueueService.ts`), so `receiptId` is added
to `FinanceQueueRow`, with its classification.

## Routes the marks alone would stop logging

Checked against the generated and synthetic classifications: these routes are
audited today, and no model they return carries a marked field. Two more,
`GET /api/income/items` and `GET /api/expense/provisional-items`, stop by
decision and are not listed.

| Route | What a row holds | Where money or a person can appear |
|---|---|---|
| `GET /api/expense/received-expense-payloads` | `ReceivedExpensePayload`: `receiptId`, `payloadJson`, `status` | `payloadJson` is the stored expense payload, with its amounts and the submitter |
| `GET /api/donations/disbursement-events` | `DisbursementEvent`: `disbursementId`, `payload` | `payload` is the stored Benevity disbursement |
| `GET /api/receipts/[id]/audit-logs` | `ReceiptAuditLog`: `fieldChanged`, `valueBefore`, `valueAfter` | the before and after values, e.g. `totalCents` 4210 → 4120 |
| `GET /api/workflow-mapping/audit-log` | `WorkflowAuditLog`: `eventType`, `fromState`, `toState`, `details` | `details`, free text on the event |
| `GET /api/expense/qb-exclusions` | `ExpenseQbMatchExclusion`: `qbTxnId`, `reason`, who excluded it | none: no amount, no payer or payee |
| `GET /api/income/qb-exclusions` | `IncomeQbMatchExclusion`: `qbTxnId`, `reason` | none |
| `GET /api/receipts/ignored-files` | `ReceiptIgnoredFileView`: `fileHash`, `reason` | none: mailbox configuration |
| `GET /api/expense/expenses/[id]/signoffs` | `ExpenseLineSignoffStatus`: per-line seat status | none; a panel of the expense page |
| `GET /api/expense/expenses/[id]/line-item-approvals` | `LineItemOwnerApproval`: bucket, status, who decided | none; a panel of the expense page |

`GET /api/donations/comment-rules` stays logged: `TransactionCommentRule.comment`
is a donor's comment text, which is marked (decided), so that field carries the
mark.

## The PR split

1. **App code: the log table.** An additive migration for the new columns
   (`pagePath`, `pageViewId`, `calls`, `records`, `recordCount`, and the index
   on person and page-view id), and the writer that fills them and merges a
   page view's calls. Nothing calls the new path yet. It ships first and on its
   own: the boundary isolation workflow
   (`.github/workflows/security-boundary-isolation.yml`) does not accept
   `prisma/migrations/` beside a boundary change, as with B11's first PR
   (#2659).
2. **Boundary: what is logged.** The mark annotation in every library schema and
   synthetic classification file, and in the generator. The handler and file
   handler logging from marks, with own-record exclusion and record naming.
   Every needed `financeView` declaration. The page-view header with its limits,
   and the page allowlist map. `receiptId` in `FinanceQueueRow`'s
   classification. Retiring the `auditedRead` flag and its guard test, which
   the start-up checks replace. The reworded `docs/rules/revenue.md` register
   line, reworded only (B11's scope is unchanged, so the Board has nothing to
   confirm).
3. **App code: the browser and the tab.** The app-shell wrapper that tags each
   `/api` call; `receiptId` in the finance-queue rows; `financeViewKinds.ts` as
   the model-to-page link map; the tab's new entry.

Until (3) ships, no call carries the header, so every call writes its own row,
as today but with exact records and fields.

## Decided

- **The unit is the page view (Q10 (a)).** The browser tags each API call with a
  page-view id and the page path; the server merges one person's calls carrying
  that id into one row, within 30 seconds and under one path. Untagged calls
  write their own rows.  [Decision — owner]
- **A per-page allowlist of routes (Q11).** A boundary declaration lists the
  routes each page may fold into its entry. A call from a route not on its
  claimed page's list writes its own row.  [Decision — owner]
- **No nouns (Q1).** An entry shows the exact page path and each record as
  `Model:id`. Example: "Pat Lee viewed Expense:e_123, Receipt:r_9 on
  /expense/expenses/e_123", not "viewed 3 expenses on the expense page".
  [Decision — owner]
- **Marked field names, never values (Q13).** Each record lists the marked
  fields sent. Example: "Pat Lee viewed `Expense:e_123` (`submitterId`,
  `receiptTotalCents`) on `/expense/expenses/e_123`".  [Decision — owner]
- **Sensitive finance fields carry a mark (Q9),** and a view is logged
  when the response sent carries a marked field on a record that is not the
  viewer's own.  [Decision — owner] The marked fields:
  - every `…Cents` amount, which logs a view on its own (Q15);
  - a donor's name and comment text (no schema stores a donor's email or
    address);
  - the person reimbursed and the vendor on an expense;
  - **the submitter:** `Receipt.uploadedByUserId` and `Expense.submitterId`;
  - **the cardholder:** no field names one today, and the submitter of a
    card-charge expense covers it. Any cardholder field added later carries the
    mark;
  - **the Shopify buyer:** `ShopOrder.customerName` and `customerEmail`, and
    `PaymentQueueRow.familyName` and `familyEmail` as the same buyer;
  - **refunds, as purchases:** a refund links to a person through its order,
    so a refund view that shows the buyer is logged the same way as the
    purchase;
  - **every payment plan,** membership plans included, though they carry no
    amount: the request fields `isPaymentPlanRequested` and
    `scholarshipRequestKind` on both `ProgramParticipant` and
    `OrgMembershipProcess`;
  - **scholarships and financial aid:** on `ProgramParticipant`, also
    `inventoryHeldAt`, `paymentPlanDeniedAt` and `seatTakenWithoutSaleAt`, per
    `docs/architecture/PROGRAM_CAPACITY_AND_SCHOLARSHIPS.md`;
  - **matched gifts, employer included:** `Transaction.companyName` and
    `matchAmountCents`;
  - **company donors:** `InKindDonation.donorCompanyName` and
    `Receipt.donorCompanyName`. Benevity's rules forbid the organisation from
    saying publicly which company gave or matched;
  - **every image and stored receipt, and the donation upload file:** the file
    fields of a receipt, a mail item and an uploaded Benevity CSV (which holds
    employers and donor names).
- **Not marked:** QuickBooks account names, and the ids of approvers and
  reviewers (`approvedByUserId`, `decidedByUserId`, `reviewedByUserId`,
  `boardAuthorizedByUserId`). They name who acted on a record, not who paid or
  was paid.  [Decision — owner]
- **Rows that point at a finance record name that record (Q4),** not the row's
  own id. Example: Income → QuickBooks exclusions lists `id 7, qbTxnId "4412"`,
  and the log names transaction 4412, not 7. The six screens: income and
  expense QuickBooks exclusions (`qbTxnId`), received expense payloads
  (`receiptId`), disbursement holds (`disbursementId` and `transactionId`),
  disbursement events (`disbursementId`), and income reconciliation
  (`payoutGid`).  [Decision — owner]
- **Payment plans name `programId:personId`;** the duplicate review names
  everything it displays; signoffs and expense detail name the expense, not its
  lines.  [Decision — owner]
- **Not logged:** `GET /api/income/items` (variants mapped to buckets) and
  catalog items and mappings such as `GET /api/expense/provisional-items`. They
  are inventory, not finance information.  [Decision — owner]
- **"Payout record" means a payout from Shopify, and nothing else.**
  [Decision — owner]
- **Records outside the app are named by system and type (Q14 (b)):**
  `QuickBooks.Transaction:4412`, `Benevity.Disbursement:BEN-889`. One name on
  every screen, from a fixed list of outside names, two today.  [Decision — owner]
- **A reload writes a new entry (Q16).** Each page load is its own page view;
  identical loads are not collapsed.  [Decision — owner]
- **Stored payloads and change values carry the mark (Q17).** Their text holds
  amounts and names that no other field mark sees, as a stored file does:
  `ReceivedExpensePayload.payloadJson`, `DisbursementEvent.payload`,
  `ReceiptAuditLog.valueBefore` and `valueAfter`, and `WorkflowAuditLog.details`.
  So received expense payloads, disbursement events and both change histories
  stay logged.  [Decision — owner]
- **Log rows written before the change stay as they are.**  [Decision — owner]
- **Any marked field logs the view, an amount on its own included (Q15).** One
  mark, with no pairing of a person with money. So the payouts list, gifts of
  goods shown to operations or inventory managers without the donor, and a
  bucket approver's expense lines stay logged, as they are today.
  [Decision — owner]
- **B11 is not narrowed (Q12, reversed by Q15).** The finance-view rule keeps
  the scope the Board ruled: every view of finance records other than a
  person's own. There is nothing for the Board to confirm.  [Decision — owner]
  Q17 decides how the five routes with no money or person keep to that.

  The register line in `docs/rules/revenue.md` changes in wording only, to say
  what the record now holds. Draft for review; `revenue.md` is unchanged until
  the boundary PR:

  > - Every view of finance records other than a person's own is recorded, each
  >   look at a donor included: who looked, on which page, which records and
  >   which of their sensitive fields, and when, never what the records said.
  >   A person looking at their own receipts is not recorded, and neither is a
  >   count. Only the Board reads the record.  [Decision — owner]

## Open questions for @thpr

Q1 to Q16 are settled or retired; their numbers stay retired.

- **Q17. The routes the marks alone would stop logging.** The four with stored
  payloads and change values are decided (see Decided). Left:
  - **Rows with no money or person** (both QuickBooks exclusion lists, ignored
    files, signoffs, line-item approvals). Two options:
    - (a) a per-route flag, `alwaysLogged`, on these five registry entries. A
      flagged route is logged whatever it sends, and names records as declared.
      B11 stays unnarrowed, and the Q4 entries for the exclusion lists stand.
      The cost is one small exception to "marks decide".
    - (b) let them stop being logged, and say so: the `revenue.md` line then
      narrows to views that show money or a person, and since B11 is a Board
      ruling, the Board confirms it. The Q4 entries for the two exclusion lists
      are dropped. Signoffs and line-item approvals lose little: they are panels
      of the expense page, whose entry already names the expense when the
      browser tags the call.

    Recommended: (a), because it keeps your decision that B11 is not narrowed,
    with nothing for the Board.

  (a) or (b) for the five?

## Follow-ups outside this design

- A candidate register line for `docs/rules/revenue.md`, for @thpr to word. The
  register has nothing on Benevity today: "Which company gave or matched
  through Benevity is not said publicly (Benevity's rules)." Not edited in
  this design PR.
- `GET /api/receipts/duplicate-queue` is registered and audited, but no route or
  handler serves it. Removing the entry is a boundary decommission of its own.
