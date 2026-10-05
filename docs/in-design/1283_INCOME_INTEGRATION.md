# Income: porting `income-app` into checkin (delta design)

## Problem

Every few days Shopify pays the organization's store takings into the bank as
one lump, a payout, net of fees and refunds. Finance has to confirm that each
payout was booked in QuickBooks as a deposit of the right amount, and work out
the ones that weren't. Nothing does that check today. checkin mirrors the
store's recent orders and payouts and reconciles orders against memberships,
but it never looks at QuickBooks, and its mirror starts at a cutover date.
Older store history exists only as CSV exports, which the retiring income
application imports and checks. Retiring it without a replacement loses that
history.

## Objective

Every paid Shopify payout, old or new, is matched to exactly one QuickBooks
deposit, or appears in a finance queue that says why it isn't. Old history
arrives by CSV upload, recent history from the mirror, and finance works both
from one screen inside checkin. Every decision is audited. Nothing is written to
QuickBooks.

## Executive summary

- **Finance** gets the source's screens under the Finance nav (CSV import,
  payouts, orders, import conflicts, unmatched) plus one new one: the QuickBooks
  reconciliation queue. The board can read all of them.
- **Two sources of Shopify data, split by date.** Before the mirror's cutover,
  income's own tables, fed by the source's CSV importers (ported as is). From
  the cutover on, the s-read mirror, read through a port and never copied.
- **The QuickBooks match is net-new.** The source has no QuickBooks code. Income
  reads deposits through the access-token source expense uses (QB-0), plus one
  read method. No second connection.
- **Cost:** a library on its own database (the source's 13 models plus one), two
  read-only ports, one call in an existing cron. No pipeline crossings.

---

**Issue:** #1283 (backlog FD4, lane L5 of the parallel port plan). Design only;
not a closing reference.

**Base architecture:** carried over unchanged from
`docs/in-design/1286_GLOBAL_CATALOG_INTEGRATION.md`,
`1287_LOCAL_INVENTORY_INTEGRATION.md` and `1272_EXPENSE_QB_INTEGRATION.md`
(in-process library, own database, checkin security regime, retired source
auth, injected `Org`, vitest + flow tests, no hosted `/api/internal`). This doc
states only what differs.

**Source:** `income-app/` in `innovationtreehouse/Inventory` at `07797b59`. QB
client: `packages/quickbooks` at worktree `crazy-wright-4e2dcf` (`a836c535`).

**Domain rules relied on** (`docs/rules/finance-payments.md`): the store is the
source of truth for what was paid and the mirror is a read-only copy;
reconciliation problems surface on the finance board; a financial control is a
flag a person signs off, not a gate; Finance Ops excludes sysadmins
(`[Unsettled]`, respected here). This design adds rules; it changes none (§9).

---

## 1. What the source is, and what changes

`income-app` (~2.2k lines) has three CSV importers (payouts, payout
transactions, orders), each storing the raw file blob plus parsed rows; a
`PayoutConflict` queue raised when a re-imported payout row disagrees with the
stored one (accept or reject); an "unmatched" screen linking payout-transaction
files to payouts by `(date, Σ net)`; list/detail pages; and an `AuditLog`. Its
only workspace deps are `@inventory/money` and `@inventory/web-auth` (+ dev
`pg-test-harness`). The port plan lists `donations`, `utils` and `workflows`;
the source imports none of them, so H3 gates this lane only through
`quickbooks`.

| Source piece | Disposition |
|---|---|
| Three CSV importers, all 12 Shopify/import models, conflict queue, unmatched screen, list/detail pages | **Ported as is** (reskin + auth swap). They are the only way pre-cutover history gets in |
| `AuditLog` | **Kept, renamed `IncomeAuditLog`** (§5) |
| Login, proxy, `route-auth`, `web-auth`, `jose` | Retired (base docs) |
| QuickBooks reconciliation | **Net-new** (§3) |

**Why CSV stays rather than loading into the mirror.** s-ingest-core can
hand-load rows (`HAND_LOADED`), but it keys every row on a Shopify GID and
validates the API's shapes. The payout summary CSV carries no payout id at all,
and checkin's grant on the mirror is SELECT-only. The CSV data stays in income.

## 2. Two sources, one payout view

Income reads payouts from both sides through one internal interface, split at
the mirror's cutover date (`mirrorFrom`, injected):

- **Before `mirrorFrom`: income's own tables** (`Payout`, `ShopifyPayoutLineItem`,
  `ShopifyOrder`), fed by CSV. Unchanged from the source.
- **From `mirrorFrom` on: the mirror**, through a read port in `contract.ts`:

```ts
interface PayoutMirror {
  paidPayoutsSince(from: Date): Promise<MirrorPayout[]>         // shop_payout
  payout(gid: string): Promise<MirrorPayout | null>
  transactions(payoutGid: string): Promise<MirrorBalanceTxn[]>  // shop_balance_transaction ⋈ shop_order.name
}
```

checkin-app binds it to three new SELECTs in `src/lib/shopifyRead/client.ts`,
reusing that module's pool: SELECT-only by grant, `min: 0`, fast idle reap, and
the "not wired → no-op" behaviour. Income never copies mirror rows, following
the `PaymentException` precedent (thin triage row, amounts re-read live).
Column lists exclude customer fields.

**The overlap rule.** A CSV payout row dated on or after `mirrorFrom` is
rejected at import with a per-row reason, never stored. Otherwise one payout
could exist twice, once by CSV and once by GID, with nothing to pair them. A
payout's reconciliation key is `csv:<Payout.id>` or `gid:<payoutGid>`.

## 3. QuickBooks: QB-0 plus one read method

Income needs the QB-0 rung of #1272 §9 and nothing above it. It reads deposits;
it never posts, so QB-2/QB-3 and the expense-specific QB-1 wiring (account
mapping, capital seed) are not prerequisites.

- **One connection.** checkin-app builds one `AccessTokenSource` (the
  Secrets-Manager read adapter) and injects the same instance into
  `configureExpense()` and `configureIncome()`. That requires the
  `AccessTokenSource` type to live in `packages/quickbooks`, not in expense's
  `contract.ts` where #1272 §9 places it; otherwise income imports expense.
  **Owner-approved; handed to L4 (QB-0).**
- **One read method.** The client pages `Purchase` and `Bill`; income needs
  `Deposit`. Add `depositsSince(from)` (a one-line `pagedSince("Deposit", …)`)
  in the QB-0 PR. Income's adapter keeps only `{ id, txnDate, totalCents,
  depositToAccount }` and discards lines, memo and entity refs (§7).
- **Before QB-0 lands** the port is unbound and the QB run no-ops, the same way
  checkin's reconciler does without the mirror. The CSV side works from day one.

### State machine 1: import conflict (ported)

`PayoutConflict.status`: `pending` → `accepted` (incoming row replaces the
stored payout) | `rejected` (stored row kept). Raised when a re-imported payout
row with the same `(date, total)` carries a different payload. Unchanged; it
applies only to CSV rows, since mirror rows converge by GID.

### State machine 2: payout ↔ detail link (ported)

A payout-transaction file links to the one CSV payout with the same date and
`total = Σ net`; zero or several candidates leave it on the **unmatched**
screen. Unchanged; it applies only to CSV rows (the mirror stores the link as a
column).

### State machine 3: QuickBooks reconciliation (new): `PayoutReconciliation`

One row per paid payout from either source, unique on the reconciliation key.
Finance books exactly one QuickBooks deposit per payout (owner-confirmed), so the
match is one-to-one.
Plain status column with a guarded transition table; no xstate, because the
source has none and this machine has six edges.

| From | Event | To |
|---|---|---|
| (none) | run: exactly one unclaimed deposit with `amount = payout net`, date in `[payoutDate, payoutDate + window]`, and (mirror only) Σ txn net = payout net | `MATCHED` (auto) |
| (none) | run: window elapsed with none / >1 candidate, or sum mismatch | `OPEN` + kind `NO_DEPOSIT` / `AMBIGUOUS_DEPOSIT` / `TXN_SUM_MISMATCH` |
| `OPEN` | a later run auto-matches (late booking) | `MATCHED` |
| `OPEN` | finance: match to a chosen deposit | `RESOLVED` (manual match) |
| `OPEN` | finance: dismiss with a required reason (e.g. booked as something other than a deposit) | `RESOLVED` (dismissed) |
| `MATCHED` / `RESOLVED` | run: deposit gone or amount changed, or payout changed (mirror update, or an accepted CSV conflict) | `OPEN` + kind `DRIFT` |

Rules: payouts not yet paid are skipped, not queued. A deposit backs at most one
payout (partial unique on the matched deposit id, so tests run `migrate deploy`,
not `db push`). A matched or resolved row snapshots `{ depositId, txnDate,
totalCents }` and the payout net it matched, which is what makes drift
detectable. Every transition writes `IncomeAuditLog` in the same transaction. A
run is idempotent and holds a Postgres advisory lock, so the cron and a manual
"run now" cannot interleave. `window` (default 7 days) and `reconcileFrom`
(default: the earliest CSV payout) are injected through `configureIncome()`.
QuickBooks history predates the store's (owner-confirmed), so every payout
should have a deposit to find. `NO_DEPOSIT` is always a real exception, never
expected noise for old payouts, and there is no bulk dismiss.

**Exception queues:** import conflicts (`pending`), unmatched details, and
reconciliation rows in `OPEN` grouped by kind.

**When it runs.** checkin cannot add a cron route: `/api/cron/*` live in the
frozen `legacy-authz-routes.txt`. Income's `runReconcile()` is called from the
existing `/api/cron/reconcile-shopify` handler after checkin's own reconcile. It
reads the same freshly synced mirror and costs no extra Aurora wake. A `FINANCE`
"run now" route covers the rest, and a CSV import triggers a run for the rows it
added.

## 4. Roles: `FINANCE`, with board read

| Source guard | checkin | Why |
|---|---|---|
| `canAccessIncome` = org role `finance` (edge proxy bounces every other role) | **`FINANCE`** (#1817 / #1314) for every read and write | 1:1 with the role expense introduces; ledger reconciliation is the bookkeeper's job |
| `requireFinanceOrManager` on conflict resolve | not carried | Dead in the source: the proxy rejects org managers before the route runs |
| (none) | **`BOARD`**: read-only on every screen | finance rule: reconciliation problems surface on the finance board |
| (none) | `SYSADMIN`: no access | Finance Ops rule excludes sysadmins (`[Unsettled]`); not widened here |

Reads stay narrow, as in expense. No viewer gate. **Gate:** income's B PR
references the `FINANCE` authorize token, so it follows L3's role PR.

## 5. Model names and collisions

| Model | Collides with | Port name |
|---|---|---|
| `AuditLog` | checkin's own `AuditLog` | **`IncomeAuditLog`**, `@@map("audit_log")` (owner-approved) |
| the other 12 source models, `PayoutReconciliation` (new) | none: checked against checkin, every `packages/*` schema and all eight Inventory app schemas | as is |

The s-ingest-core mirror has no `generator security`, so its `ShopOrder` /
`ShopPayout` never enter the classification map. Actor columns keep the source
names (`uploadedByUserId`, `resolvedByUserId`, `actorUserId`); none is in
`SCOPABLE_FIELDS`, so **zero scopeBindings, zero `OPT_OUT_PENDING_ROUTE`
entries.** Values are checkin `Person.id` from the injected principal (the
source's are `Int`; `Person.id` is too). The source's two migrations port as is,
plus one adding `PayoutReconciliation` and the rename's `@@map`.

## 6. Surface and routes (all registered in B)

Pages (Finance nav section tabs, gated `FINANCE`/`BOARD`): the source's
`payouts`, `payouts/[id]`, `payout-details`, `orders`, `orders/[id]`,
`conflicts`, `unmatched`, plus a new `reconciliation`. Payouts list both sources
and show each row's origin.

| Route | Verb | Gate | Origin |
|---|---|---|---|
| `/api/income/payouts`, `/payouts/[id]` | GET | FINANCE, BOARD | ported; `[id]` takes a CSV id or a mirror GID |
| `/api/income/payouts/import`, `/payout-details/import`, `/orders/import` | POST (multipart) | FINANCE | ported |
| `/api/income/payouts/import-history`, `/payout-details/import-history` | GET | FINANCE, BOARD | ported |
| `/api/income/orders`, `/orders/[id]` | GET | FINANCE, BOARD | ported (CSV orders only) |
| `/api/income/conflicts` | GET | FINANCE, BOARD | ported |
| `/api/income/conflicts/[id]/resolve` | POST | FINANCE | ported |
| `/api/income/unmatched` | GET | FINANCE, BOARD | ported |
| `/api/income/reconciliation`, `/reconciliation/count` | GET | FINANCE, BOARD | new |
| `/api/income/reconciliation/[id]/candidates` | GET | FINANCE | new (live QB, ±window) |
| `/api/income/reconciliation/[id]/resolve`, `/reconciliation/run` | POST | FINANCE | new |

Dropped: `auth/{login,logout}`, `health`. Source list routes return
`{rows,total}`; per the base docs they become bare arrays plus a `.../count`
endpoint where paging is needed (payouts, orders). Mirror and QB rows, and the
import/unmatched summaries, are not Prisma models, so the stripper would drop
them. Each needs a **synthetic classification** (the `CatalogItemCount`
pattern, #1286 §5): `IncomePayoutView` (union of both origins),
`IncomeBalanceTxnView`, `IncomeQbDepositView`, `IncomeImportSummary`,
`IncomeUnmatchedView`, and the counts. These go in B, and they are the main way
this boundary PR differs from the other lanes'.

## 7. Sensitivity

Income does carry buyer PII, as the plan expects: `ShopifyCustomer` (email,
billing name, street, address lines, company, city, zip, province, country,
phone) and the raw CSV blobs (`ShopifyOrderBlob.payload`, which holds the same
fields).

- **`pii`**: every `ShopifyCustomer` contact field; `ShopifyOrderBlob.payload`.
  The order list/detail routes return customer name and email only to `FINANCE`;
  `BOARD`'s read of orders gets the order without the customer.
- **`internal`**: all amounts and dates, payout/deposit ids and snapshots, order
  names, line items, statuses, file names and hashes, actor ids/usernames, free
  text (`reason`), the other blob payloads (payout and payout-detail CSV rows
  carry no person data), audit `before`/`after`, and every synthetic view field.
- **`public`**: row ids only. **No `secret`.**
- **Pins in B's security tests:** the mirror port selects no customer columns;
  the deposit adapter discards QB `Line[]`, `PrivateNote` and entity refs (QB
  lines can name a customer); and audit `before`/`after` for orders never embed
  the customer. Widening any of these is a re-tier in its own boundary PR.

## 8. Phasing: three PRs, each based on `main`

1. **S: `packages/income/` only.** Port the source (schema, both migrations,
   importers, CSV parsers, services, repositories, pages/components) with the
   `AuditLog` rename. Add the overlap rule (§2), `PayoutReconciliation` + its
   migration + engine, `contract.ts` (`IncomeAuth`, `PayoutMirror`,
   `QbDepositSource` taking `AccessTokenSource` from `packages/quickbooks`),
   route factories, and a dev seed built from the source's e2e CSV fixtures,
   stamped with the seeded `Org` id. Tests: the source's unit tests port near
   verbatim; its route+auth integration tests become flow tests in W; new
   pg-test-harness DB tests cover every reconciliation transition, idempotent
   re-run, drift, one-deposit-one-payout, the overlap rule and the advisory lock.
   The DB tier skips silently without `DOCKER_HOST`. The body carries the plan's
   filtered `diff -r` for the ported part, and lists the new files separately.
   Depends on H3 vendoring `packages/quickbooks` (for the type only).
2. **B: boundary, alone, registry-first.** `@sensitivity` on the income schema,
   `generator security`, `security/registry/income.ts` with every §6 route, the
   synthetic classifications, the merge-list line, security tests (stripper over
   each view, the PII split between FINANCE and BOARD, the §7 pins). Depends on S
   and on L3's `FINANCE` role PR.
3. **W: wiring.** Route + page stubs, `pageRegistry`, Finance nav tabs,
   `configureIncome()` via the `LIBRARIES` list (H2), the `PayoutMirror`
   adapter, the shared `AccessTokenSource` binding (inert until QB-0), the call
   in `cron/reconcile-shopify`. Flow tests carry the source's integration and
   Playwright journeys: import the three fixture CSVs, re-import a changed payout
   and resolve the conflict, link a detail file, read unmatched; BOARD reads but
   gets 403 on writes and sees no customer fields; a non-finance persona gets 403
   everywhere. The flow compose has no mirror and no QB, so mirror and deposit
   matching are covered by S's DB tier, not flow tests.

QB-0 (L4) gates live deposit matching, not any of these PRs.

**Crossings: none.** Income calls no other library and no library calls income.
Its dependencies are host-provided (the mirror bridge, the QB token source) and
one shared package. The only cross-lane touch is the `AccessTokenSource`
location and `depositsSince`, both inside L4's QB-0 PR (§3).

## 9. Distillation at merge

Add to `docs/rules/finance-payments.md` (Procedure → Reconciliation); no new
register file:

- Every paid store payout is matched to exactly one ledger deposit, or is raised
  for finance with the reason. A deposit backs at most one payout. `[Decision]`
- Payout reconciliation only reads the ledger; it never writes or corrects an
  entry there. `[Decision — deliberate limit]`
- A payout or deposit that changes after it was reconciled reopens for finance;
  it is never silently re-matched. `[Decision — *Principle: people decide about people*]`
- Store history before the mirror's start comes from uploaded exports, and only
  from them; an export never overrides a period the mirror covers. `[Decision]`
- Buyer contact details from uploaded exports are visible to finance only.
  `[Decision — *Principle: least privilege*]`

Mechanism (ports, cron hook, synthetic views) is deleted with this doc.

## Alternatives considered

- **Load old CSVs into the s-read mirror** (`HAND_LOADED`). Rejected: the mirror
  keys on Shopify GIDs, the payout summary CSV has none, and checkin's grant on
  the mirror is SELECT-only.
- **Re-pull old history from the Shopify API** by moving s-read's cutover back.
  Rejected: the API does not reach back far enough (owner-confirmed), which is
  why the CSVs exist.
- **Fold the QB match into checkin's `lib/finance/reconcile.ts`.** Rejected: it
  would need the CSV tables too, and the plan places every Inventory app in its
  own library.
- **Reconcile per order against QB sales receipts.** Rejected: the bank sees
  payouts, and finance books one deposit per payout (owner-confirmed).
