# Record ids for finance views whose rows have no `id`

Design for the gap in the finance view record (the finance-view rule in
`docs/rules/revenue.md`): five audited routes write a row that names no record.
No code changes with this doc.

## The gap

On an `auditedRead` route, `handler()` takes a record id from each top-level row
of the **stripped** bag: `row.id ?? row.payoutGid`
(`checkin-app/src/security/handler.ts`). The `payoutGid` fallback is already a
hard-coded exception for one route. `rowCount` is the number of top-level rows,
across every bag key.

The rule says the record holds "which records". For these five routes it holds
a count and the path params only:

| Route | Top-level row | What identifies the finance record | Survives the stripper? |
|---|---|---|---|
| `GET /api/expense/expenses/[id]/signoffs` | `ExpenseLineSignoffStatus`, one per visible line | The expense is the path `id`, already in `params`. Each row's `lineItemId` names the line. | `lineItemId` is `internal`. Every audience in `APPROVER_VIEW` holds `everyones:internal` (Finance, Board, and the bucket approver as `authenticated`). Yes for all. |
| `GET /api/expense/finance-queue` | `FinanceQueueRow`, one per expense on the chosen tab | `expenseId` | `expenseId` is `internal`; Finance and Board both hold it. Yes for all. |
| `GET /api/income/items` | `IncomeItemView`, one per Shopify variant | `variantId` (a catalog variant and its bucket mapping, not a payout) | `variantId` is `internal`; Finance and Board both hold it. Yes for all. |
| `GET /api/receipts/[id]/duplicate-group` | One `ReceiptDuplicateGroup` | The path `id` names the receipt asked about. The receipts shown are `members[].id`, plus the ids in `dismissed`. | `members[].id`, `copyOfId` and `dismissed` are `pii`. Finance and Board both hold `everyones:pii` in `FINANCE_READ_VIEW`. Yes for all. |
| `GET /api/finance-ops/payment-plans` | `ProgramParticipant`, one per pending request, plus one `BoardSettings` | The enrollment's composite key, `programId` + `personId`. There is no single id column. | Both are `public`. Yes for all. |

Two side findings from reading these:

- **payment-plans counts and names `BoardSettings`.** `BoardSettings.id` is
  `public`, so it survives, and the handler records it as record id `"1"` and
  counts it as a row. Every view logs one more row than it shows, and an empty
  queue still writes a row (count 1, id `"1"`).
- **The same applies to any audited route with a non-record sibling key.** The
  handler counts every top-level row in every bag key, for example
  `ExpenseQueueReason` beside `Expense` on the expense detail. Those reasons have
  no `id`, so they add to the count but not the ids.

## What the Board's tab can link

`checkin-app/src/lib/finance/financeViewKinds.ts` decides the kind label, the
sentence and which ids link to a page. It is app code, not a boundary file.

The tab and its search both read `recordIds` only, never `params`:

- The tab renders one entry per id in `row.recordIds`
  (`RecordIds` in `checkin-app/src/app/system-status/finance-views/page.tsx`),
  and `financeViewRecordHref` links only an id it is given. A row with empty
  `recordIds` shows no record at all.
- The record search on `GET /api/system-status/finance-views` filters with
  `recordIds: { has: record }`. A path id held only in `params` is not found.

So a path `id` names the record in the stored row, but the Board can neither see
it on the tab nor find it by searching for the expense or receipt. Whatever
mechanism lands, it needs these entries:

- `GET /api/expense/finance-queue` → a `LIST_PAGES` entry to `/expense/expenses`,
  once its rows carry expense ids.
- `GET /api/expense/expenses/[id]/signoffs` → a `DETAIL_PAGES` entry to
  `/expense/expenses`, once the expense id is in `recordIds` (or the tab and the
  search read it from `params`; see option D).
- `GET /api/receipts/[id]/duplicate-group` → a `DETAIL_PAGES` entry for the path
  `id`, on the same condition. Member ids are receipts too, so they could link
  to `/receipts/<id>` as a list does.
- `GET /api/income/items` → falls under the `payouts` kind by its `/api/income`
  prefix, so the tab reads "viewed 40 payout records". "Payout record" means a
  Shopify payout only (decided below), so items need a kind of their own. A
  variant has no page of its own. The same prefix also labels two other
  non-payout audited reads as payout records: `GET /api/income/qb-exclusions`
  (QuickBooks transactions excluded from matching) and
  `GET /api/income/reconciliation/[id]/candidates` (QuickBooks deposits offered
  as a match). The payout routes are `GET /api/income/payouts`,
  `GET /api/income/payouts/[gid]` and `GET /api/income/reconciliation`.
- `GET /api/finance-ops/payment-plans` → the `payments` kind. Its ids are
  `programId:personId` (decided below), so the tab and the search take that
  format, and the tab needs a page to link it to, if any.

## Options

### A. Registry entry names the id field: `auditedId`

An optional field on `RouteSpec` (and `FileRouteSpec`) that tells the handler
where a top-level row's record id is, in place of `id`. The handler still reads
the stripped bag, so only an id the caller actually received is recorded.

Shapes, smallest first:

1. **One field name** (`auditedId: 'expenseId'`). Covers finance-queue, income
   items and signoffs (`lineItemId`). Retires the `payoutGid` special case into
   the payouts entry. Does not cover the duplicate group (nested) or payment
   plans (composite).
2. **A list of field names joined into one id** (`auditedId: ['programId',
   'personId']`, recorded as `programId:personId`). Adds payment plans.
3. **Paths into the row** (`auditedId: ['members[].id', 'dismissed[]']`). Adds
   the duplicate group's members. Needs a small path grammar in the handler, and
   tests for it.

A per-route key filter (`auditedKeys: ['ProgramParticipant']`) would fix the
`BoardSettings` count, with the same reasoning.

Trade-offs: one declaration per route, read where the policy is already read;
the logged ids are what left. It grows the registry's grammar, and every grammar
addition is something a reviewer must learn. **Boundary change** (`core.ts`,
`handler.ts`, the registry entries, their tests). Then **app code** for
`financeViewKinds.ts`, in a separate PR.

### B. Routes return an `id` on each row

Each handler adds `id` to its rows: `id: expenseId` on `FinanceQueueRow`, and so
on. The handler stays as it is.

Trade-offs: no new grammar. But:

- The stripper drops any unclassified field, so each new `id` needs a
  classification entry. The synthetic classification files are boundary
  artifacts, so it is a **boundary change** per model plus **app code** per route
  (in `packages/expense`, `packages/income`, `packages/receipt`, and the
  payment-plans route).
- `ProgramParticipant` is a Prisma model with no `id` column. An `id` there means
  a new view model or a schema column, much more than this gap needs.
- It duplicates a field the response already carries, in a public contract.
- It cannot name the duplicate group's members: the group is one row with one
  `id`.

### C. The route hands the handler its ids

`HandlerFn` returns the ids alongside the bag (a reserved bag key, or a
`recordViewed(ids)` callback on the context).

Trade-offs: handles any shape, including nested and composite. But the ids come
from the **unstripped** data, so the log can name a record the caller never
received, or miss one they did; and every route must remember to do it.
**Boundary change** (`handler.ts`) and **app code** per route.

### D. The path `id` as the record, for the detail routes

For signoffs and the duplicate group, the path `id` already names the record the
screen is about, and it is stored in `params`. A `DETAIL_PAGES` entry alone does
nothing: the tab and the search read `recordIds` only. Two ways to use it:

1. **The handler records the path `id`.** A registry flag (for example
   `auditedPathId: 'id'`) makes the handler add `params.id` to `recordIds`. The
   file handler already does this for file routes (`result.row.id ?? params.id`
   in `fileHandler.ts`), so there is a precedent. The tab links it through a
   `DETAIL_PAGES` entry, and the search finds it with the existing index.
   **Boundary change**, then **app code** for `financeViewKinds.ts`.
2. **The tab and the search read `params.id`.** `RecordIds` renders the detail
   record from `params` when `recordIds` lacks it, and the search also matches
   `params.id` for detail endpoints. **App code only.** The `params` match is a
   JSON-path filter that the `recordIds` GIN index does not serve, and the search
   needs to know which endpoints are detail endpoints.

Either way, D records neither the line ids nor the other receipts in the
duplicate group. Those need A.3 or C.

## Recommendation

A.1 (one field name) for the finance queue and income items, with `payoutGid`
moved into its registry entry. That closes the gap on the finance queue, the
most-used screen, with the smallest grammar. Signoffs record only the path's
expense id (decided below), so D covers them; which variant is Q1a.

Two of the decisions below need more than A.1. Payment plans need joined fields
(A.2) or C. The duplicate review needs paths into the row (A.3) or C, because its
ids are nested in one group row. Which one is Q1.

## Decided

- **Payment plans record `programId:personId`.** One id per pending request
  shown, the program id and the person id joined by a colon.  [Decision — owner]
- **The duplicate review records everything it displays.** Every receipt id the
  group shows: each member's `id`, each member's `copyOfId`, and each id in
  `dismissed`, as well as the receipt in the path.  [Decision — owner]
- **Signoffs record the expense in the path, not its lines.** One id, the
  expense's; the line ids the response carries are not recorded.  [Decision — owner]
- **Income items stay an audited read.**  [Decision — owner]
- **"Payout record" means a payout from Shopify, and nothing else.** No other
  income read is labelled a payout record on the Board's tab.  [Decision — owner]

## Open questions for @thpr

- **Q1.** **Which mechanism?** A (registry field), B (routes return `id`), C (route
  hands over ids), or D only for the detail routes. If A, which shape: one
  field name, joined fields, or paths.
- **Q1a.** **The detail routes' path `id`.** D.1 (the handler records it in
  `recordIds`, a boundary change) or D.2 (the tab and the search read it from
  `params`, app code only, unindexed)?
- **Q2.** **Payment plans' `BoardSettings`.** Should it stop counting as a row and
  being recorded as id `"1"`?
- **Q5.** **Income kind labels.** Which label does the Board's tab give
  `GET /api/income/items` (a Shopify variant and its bucket), and the two
  QuickBooks reads under `/api/income` (`qb-exclusions` and reconciliation
  `candidates`)?
- **Q6.** **Sibling keys on other audited routes.** Should the count exclude rows that
  are not records (such as `ExpenseQueueReason` on the expense detail), or is
  that a separate change?

Log rows written before the change keep their count only; there is nothing to
backfill them from.
