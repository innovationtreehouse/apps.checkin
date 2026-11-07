# Finance view log: record what was viewed, not a guess

Design for making the finance view record (the finance-view rule in
`docs/rules/revenue.md`) say exactly what each look at finance information
showed: who looked, on which page, which records, and which sensitive fields
of them. No code changes with this doc.

**Status: under discussion, nothing is being built.** Decided except for:

- **Q12:** narrowing Board ruling B11 to views that link people to money is
  decided for now, but waits for the Board's confirmation at its next meeting.
  The boundary PR waits for it.
- **Q14:** how to name the records that live outside the app (QuickBooks,
  Benevity).
- **Q15:** two decisions conflict. The field marks (Q9) cover every amount,
  and Q12 says views of amounts with no person stop being logged.
- **Q16:** whether a reload may write a new entry.

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

Fields that link a person to money carry a mark (Q9, decided; the field list is
under Decided). A view is logged when the response, **after the stripper has
run**, carries a marked field on a record that is not the viewer's own. The
`auditedRead` flag on each route is no longer what decides logging: a new route
that sends a marked field is logged with nothing to remember.

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
  names QuickBooks transaction `qbTxnId`, not its own `id`.
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
- `model` names the model the id belongs to. It must be a model in the
  classifications.
- `query` lists the query parameters that pick the screen (§4).

**Checked when the server starts.** Registration throws when:

- a route can send a marked field on rows with no `id` and has no declaration;
- a declared field is not classified on its model;
- a declared `model` is not in the classifications;
- a declared id is not visible to every role in the route's `orderedView` that
  can see the marked field. If it were not, that role's views would name no
  record, silently.

Ids are read from the stripped response, so the log names only what left the
server.

Records with no model in the app, a QuickBooks transaction or a Benevity
disbursement, are Q14.

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
only after its 30 seconds have passed. This is Q16, for @thpr to confirm.

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
| `GET /api/expense/qb-exclusions`, `GET /api/income/qb-exclusions` | QuickBooks transaction ← `qbTxnId` (Q4, Q14) |
| `GET /api/expense/expenses/[id]/qb-candidates`, `GET /api/income/reconciliation/[id]/candidates` | QuickBooks transaction ← the candidate's `id` (Q14) |
| `GET /api/expense/donated-capital` | `DonatedCapitalLine` ← `id` (a view model) |
| `GET /api/receipts/[id]/duplicate-group` | `Receipt` ← param `id`, `members[].id`, `members[].copyOfId`, `dismissed[]` (decided) |
| `GET /api/receipts`, needs-attention, confirmations, `[id]` | `Receipt` ← `id` (view models of `Receipt`) |
| `GET /api/workflow-mapping/receipts`, `[id]`, audit-log | `ReceivedReceipt` ← `id`, or ← `receivedReceiptId` on the audit log |
| `GET /api/donations/disbursement-holds` | Benevity disbursement ← `disbursementId` (Q14); `Transaction` ← `transactionId` (Q4) |
| `GET /api/donations/disbursement-events` | Benevity disbursement ← `disbursementId` (Q4, Q14) |
| `GET /api/donations/in-kind/queue`, by-bucket | `InKindDonation` or `ManualInKindDonation` by `source` ← `id` |
| `GET /api/donations/in-kind/receipt/[id]`, `manual/[id]` | `InKindDonation` / `ManualInKindDonation` ← param `id` |
| `GET /api/income/payouts`, `payouts/[gid]` | `ShopPayout` ← `payoutGid`, or ← param `gid` |
| `GET /api/income/reconciliation` | `ShopPayout`, or a Benevity disbursement (Q14), by `source` ← `payoutGid` (Q4) |
| `GET /api/finance-ops/payments` | `PaymentException` ← `id` (a view model) |
| `GET /api/finance-ops/payment-plans` | `ProgramParticipant` ← `['programId','personId']` (decided) |
| file routes (receipt file, mail-item file, donation upload) | the file's record ← param `id` |

Not logged, by decision: `GET /api/income/items` (an item-to-bucket mapping)
and `GET /api/expense/provisional-items` (catalog), whatever marks they carry.

The finance-queue's intake rows need a response change. A row for a receipt
with no expense yet carries neither `expenseId` nor the receipt id (`rowsOf` in
`packages/expense/src/services/financeQueueService.ts`), so `receiptId` is added
to `FinanceQueueRow`, with its classification.

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
   line. **It waits for the Board's confirmation of Q12.** If the Board says
   no, the marks stay, and views of amounts with no person keep being logged;
   Q15 then needs answering again.
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
- **Fields that link a person to money carry a mark (Q9),** and a view is logged
  when the response sent carries a marked field on a record that is not the
  viewer's own.  [Decision — owner] The marked fields:
  - every `…Cents` amount (but see Q15);
  - a donor's name and comment text (no schema stores a donor's email or
    address);
  - the person reimbursed and the vendor on an expense (but see Q15);
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
- **Log rows written before the change stay as they are.**  [Decision — owner]
- **B11 narrows to views that link people to money (Q12).** A view of amounts
  with no person in it stops being logged: the payouts list, gifts of goods
  shown to operations or inventory managers without the donor, and a bucket
  approver's expense lines without the submitter or reimbursee.
  [Decision — owner, pending Board confirmation at its next meeting]

  Draft wording for the `docs/rules/revenue.md` register line, for review only.
  `revenue.md` is unchanged until the boundary PR:

  > - Every view that links a person to money is recorded, other than a person's
  >   view of their own: a donor, a buyer, a submitter, a person reimbursed, or
  >   a person asking for a payment plan or a scholarship, seen beside a gift,
  >   an amount or the request. The record holds who looked, which records and
  >   which of their sensitive fields, on which page, and when, never what the
  >   records said. A view of amounts with no person in it is not recorded, and
  >   neither is a count. Only the Board reads the record.  [Decision — owner;
  >   Board ruling B11, narrowed]

## Open questions for @thpr

Q1 to Q13 are settled or retired; their numbers stay retired.

- **Q14. Records with no model in the app.** Some ids name records that live
  only in another system: a QuickBooks transaction (`qbTxnId` on both QuickBooks
  exclusion lists, and the ids on the two QuickBooks candidate lists), and a
  Benevity disbursement (`disbursementId` on disbursement holds and events, and
  Benevity rows in income reconciliation). No schema model names them. Options:
  - (a) name them by the field they came from, for example
    `IncomeQbMatchExclusion.qbTxnId:4412`. It is exact and needs no list, but
    one QuickBooks transaction has a different name on each screen, so "who
    looked at transaction 4412" searches several names;
  - (b) name them by the outside system and its record type, for example
    `QuickBooks.Transaction:4412` and `Benevity.Disbursement:BEN-889`. The same
    transaction has one name everywhere, at the cost of a list of outside names
    to keep: two today.

  Which?

- **Q15. Amounts alone, and the vendor.** Two decisions conflict:
  - Q9 marks every `…Cents` amount and the vendor, and logs a view that carries
    **any** marked field.
  - Q12 says a view of amounts with no person stops being logged.

  Examples:
  - The payouts list sends `IncomePayoutView.netCents`. That is an amount,
    marked under Q9, so it would be logged, but Q12 says it is not.
  - A bucket approver's expense list sends `Expense.receiptTotalCents` and
    `Expense.vendorName`, both marked under Q9, so it would be logged, but Q12
    lists it as not logged.

  Options. None is decided.

  - **(a) Two marks: `who` and `money`.** A view is logged when one record
    carries both. `who` covers the submitter, the reimbursee, a donor's name
    and comment, a company donor, and the Shopify buyer. `money` covers every
    `…Cents` amount. This breaks three of @thpr's decisions:
    - **Payment plans and scholarship requests.** A
      `ProgramParticipant` or `OrgMembershipProcess` request names a person,
      but the price is on `Program` and is public, so there is no `money`
      field on the record. Yet "payment plans are all sensitive" and
      "scholarships, financial aid are sensitive".
    - **Benevity company names.** `Transaction.companyName` and
      `donorCompanyName` are sensitive even with no amount beside them,
      because Benevity's rules forbid saying publicly which company gave.
    - **Stored files.** The contents of a receipt file, a mail-item file or a
      donation upload CSV cannot be seen by any field mark.
  - **(b) Three marks: `who`, `money` and `standalone`.** A view is logged when
    one record carries both `who` and `money`, **or** carries any `standalone`
    field. `who` and `money` are as in (a). `standalone` covers:
    - the payment-plan and aid fields: `isPaymentPlanRequested` and
      `scholarshipRequestKind` on both `ProgramParticipant` and
      `OrgMembershipProcess`, and `inventoryHeldAt`, `paymentPlanDeniedAt`
      and `seatTakenWithoutSaleAt` on `ProgramParticipant`;
    - company names: `Transaction.companyName`,
      `InKindDonation.donorCompanyName` and `Receipt.donorCompanyName`;
    - the file fields of a receipt, a mail item and an uploaded donation file.

    Examples under (b):
    - The payouts list sends `IncomePayoutView.netCents`, which is `money` only:
      **not logged**, as Q12 says.
    - A bucket approver's expense list sends `Expense.receiptTotalCents`
      (`money`) and `Expense.vendorName`. With the vendor not a `who` (below),
      the list is **not logged**, as Q12 says.
    - The payment-plan queue sends `ProgramParticipant.isPaymentPlanRequested`,
      a `standalone` field: **logged**.
    - A Benevity gift shown without its amount still sends
      `Transaction.companyName`, a `standalone` field: **logged**.
    - Serving a receipt image to Finance: **logged**.

    One consequence to know about. `ProgramParticipant.isPaymentPlanRequested`
    and `paymentPlanDeniedAt` are `personal`, and program lead mentors hold
    `their_program_participants:personal`. So any program-lead screen that sends
    those fields would be logged as a finance view.

  **Recommended: (b).** It is the only option that keeps every decision.

  **The vendor.** Recommended: the vendor is **not** a `who`. A vendor is usually
  a business, and @thpr's test is linking *people* to money. The case where the
  vendor is a person (the reimbursee shown as vendor) is already covered by the
  reimbursee's own mark.

  Which option, and is the vendor a `who`?

- **Q16. Reloads.** A page-view row is keyed by person and page-view id. A
  reload is a new page load with a new id, so it writes a new row: three
  reloads of `/expense/expenses/e_123` within a minute are three entries.
  Collapsing identical page loads within the fifteen-minute window is not
  done, because a page-view row is complete only after its 30 seconds have
  passed. Untagged rows still collapse as today. Is a new entry per reload
  acceptable?

## Follow-ups outside this design

- A candidate register line for `docs/rules/revenue.md`, for @thpr to word. The
  register has nothing on Benevity today: "Which company gave or matched
  through Benevity is not said publicly (Benevity's rules)." Not edited in
  this design PR.
- `GET /api/receipts/duplicate-queue` is registered and audited, but no route or
  handler serves it. Removing the entry is a boundary decommission of its own.
