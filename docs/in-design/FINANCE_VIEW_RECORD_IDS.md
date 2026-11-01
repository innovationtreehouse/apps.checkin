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
Whatever mechanism lands, it needs these entries:

- `GET /api/expense/finance-queue` → a `LIST_PAGES` entry to `/expense/expenses`,
  once its rows carry expense ids.
- `GET /api/expense/expenses/[id]/signoffs` → a `DETAIL_PAGES` entry to
  `/expense/expenses`. The path `id` links already, with no handler change.
- `GET /api/receipts/[id]/duplicate-group` → a `DETAIL_PAGES` entry for the path
  `id`. Member ids are receipts too, so they could link to `/receipts/<id>` as
  a list does.
- `GET /api/income/items` → falls under the `payouts` kind by its `/api/income`
  prefix, so the tab reads "viewed 40 payout records". A variant has no page of
  its own.
- `GET /api/finance-ops/payment-plans` → the `payments` kind. A composite id needs
  a format the tab can parse, and the tab needs a page to link it to, if any.

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

### D. No mechanism for the detail routes

For signoffs and the duplicate group, the path `id` already names the record the
screen is about. A `DETAIL_PAGES` entry in `financeViewKinds.ts` links it, with no
handler change. **App code only.** It does not record the line ids, or the other
receipts in the duplicate group.

## Recommendation

D for signoffs now (app code only), and A.1 (one field name) for finance-queue
and income items, retiring `payoutGid` into its registry entry. That closes the
finance-queue gap, the most-used screen, with the smallest grammar. Payment plans
and duplicate-group members wait on questions 2 and 3 below.

## Open questions for @thpr

1. **Which mechanism?** A (registry field), B (routes return `id`), C (route
   hands over ids), or D only for the detail routes. If A, which shape: one
   field name, joined fields, or paths.
2. **Payment plans.** Should its record ids be the composite
   `programId:personId`, the `personId` alone, or nothing beyond the count? And
   should `BoardSettings` stop counting as a row and being recorded as id `"1"`?
3. **Duplicate group.** Should the record name every member receipt shown (and
   the dismissed ids), or only the receipt in the path?
4. **Signoffs.** Is the expense in the path enough, or should the line ids be
   recorded as well?
5. **Income items.** A variant's bucket mapping is not a payout. Should
   `GET /api/income/items` stay an audited read, and if so, under which kind
   label in the Board's tab?
6. **Sibling keys on other audited routes.** Should the count exclude rows that
   are not records (such as `ExpenseQueueReason` on the expense detail), or is
   that a separate change?

Log rows written before the change keep their count only; there is nothing to
backfill them from.
