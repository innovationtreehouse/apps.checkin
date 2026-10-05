# Income: porting `income-app` into checkin (delta design)

## Problem

Every few days Shopify pays the organization's store takings into the bank as
one lump, a payout, net of fees and refunds. Finance has to confirm that each
payout was booked in QuickBooks as a deposit of the right amount, and work out
the ones that weren't. Nothing does that check today. checkin already mirrors
the store's orders and payouts, and it reconciles orders against memberships
and enrollments, but it never looks at QuickBooks. The retiring income
application doesn't either: it is a CSV importer for the same Shopify data,
with a queue for re-imports that disagree.

## Objective

Every paid Shopify payout is matched to exactly one QuickBooks deposit, or
appears in a finance queue that says why it isn't. Finance clears that queue
inside checkin, and every decision is audited. Nothing is written to
QuickBooks.

## Executive summary

- **Finance** gets two screens under the Finance nav: payouts with their
  reconciliation state, and an exception queue for payouts that did not match a
  deposit. The board can read both.
- **The port is mostly retirement.** s-read already mirrors orders, payouts and
  balance transactions from the Shopify API, so income reads the mirror and
  keeps no Shopify data of its own. The source's CSV importers are not ported:
  the history the API can't reach is loaded into the mirror once, by the
  source's own conversion script (`1283_INCOME_INTEGRATION-migration.md`).
- **The QuickBooks match is net-new.** The source has no QuickBooks code. Income
  reads deposits through the access-token source expense uses (QB-0), plus one
  read method. No second connection.
- **Cost:** a two-model library on its own database, two read-only ports, and
  one call added to an existing daily cron. No pipeline crossings.

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

## 1. What the source is, and what survives

`income-app` (~2.2k lines) has three CSV importers (payouts, payout
transactions, orders), each storing the raw blob plus parsed rows; a
`PayoutConflict` queue raised when a re-imported payout row disagrees with the
stored payload (accept or reject); an "unmatched" screen pairing payout
transaction files with payouts by `(date, Σ net)`; list/detail pages; an
`AuditLog`; and `scripts/csv-to-fixtures.mjs`, which converts the same three
exports into s-read fixture nodes. Its only workspace deps are
`@inventory/money` and `@inventory/web-auth` (+ dev `pg-test-harness`). The
port plan lists `donations`, `utils` and `workflows`; the source imports none of
them, so H3 gates this lane only through `quickbooks`.

| Source piece | Disposition | Why |
|---|---|---|
| Three in-app CSV importers, all `*ImportFile` + `*Blob` models | **Not ported** | The CSV load happens once (owner decision), so it runs as an operator step through `csv-to-fixtures.mjs` and s-read's `inject`, not as an app feature |
| `ShopifyOrder`, `ShopifyOrderLineItem`, `ShopifyCustomer`, `Payout`, `ShopifyPayoutLineItem` | **Not ported** | Mirror tables `shop_order`, `shop_order_line`, `shop_payout`, `shop_balance_transaction` hold both API data and the loaded history |
| `PayoutConflict` (re-import payload mismatch) | **Not ported** | With no in-app import there is no re-import. A payout that changes after we reconciled it is still a conflict; it becomes the `DRIFT` kind (§3) |
| Unmatched screen (payout ↔ detail file by date + Σ net) | **Reformulated** | The mirror stores `payout_gid` on each balance transaction. What survives is an integrity check: payout net ≠ Σ its transactions' net → `TXN_SUM_MISMATCH` |
| Orders list/detail | **Not ported** (deliberate limit) | Order-level truth is checkin's existing reconciler (`finance-ops/payments`). Payout detail shows each transaction's order name |
| `AuditLog` | **Kept, renamed `IncomeAuditLog`** | §5 |
| Payouts list/detail, conflicts page | **Rewritten** as payouts + reconciliation queue | §6 |
| `csv-to-fixtures.mjs` | **Used once, from the Inventory repo at a pinned SHA**, not ported | migration doc |
| QuickBooks reconciliation | **Net-new** | The backlog item's headline; absent from the source |

So the plan's review device (S body = filtered `diff -r` against the source)
does not fit this lane: almost nothing is verbatim. The S body carries the table
above as its port-diff, file by file.

## 2. Reuse of s-read data: read, never copy

Income stores **no copy** of Shopify data, following the `PaymentException`
precedent: a thin triage row keyed by the Shopify id, with amounts re-read live
from the mirror at view time.

The library declares a read port in `contract.ts`:

```ts
interface PayoutMirror {
  paidPayoutsSince(from: Date): Promise<MirrorPayout[]>         // shop_payout
  payout(gid: string): Promise<MirrorPayout | null>
  transactions(payoutGid: string): Promise<MirrorBalanceTxn[]>  // shop_balance_transaction ⋈ shop_order.name
}
```

checkin-app binds it to three new SELECTs in `src/lib/shopifyRead/client.ts`,
reusing that module's pool: SELECT-only by grant, `min: 0`, fast idle reap, and
the "not wired → no-op" behaviour. The library opens no connection to the mirror
and never imports `s-ingest-core`; the mirror has no `generator security`, so
nothing of it enters the classification map. Column lists exclude
`customer_email` / `customer_name`. Income never needs to know who bought.

Loaded history and API data look the same to income. The one difference: a
loaded payout whose id the script could not recover has no transactions, so it
lands as `TXN_SUM_MISMATCH` for finance rather than matching silently.

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
- **Before QB-0 lands** the port is unbound, and the run no-ops the same way
  checkin's reconciler does without the mirror. Income can ship S/B/W ahead of
  QB-0.

### Reconciliation state machine: `PayoutReconciliation`

One row per paid payout, unique on `payoutGid`. Finance books exactly one
QuickBooks deposit per payout (owner-confirmed), so the match is one-to-one.
Plain status column with a guarded transition table; no xstate, because the
source has none and this machine has six edges.

| From | Event | To |
|---|---|---|
| (none) | run: exactly one unclaimed deposit with `amount = payout net`, date in `[issuedAt, issuedAt + window]`, and Σ txn net = payout net | `MATCHED` (auto) |
| (none) | run: window elapsed with none / >1 candidate, or sum mismatch | `OPEN` + kind `NO_DEPOSIT` / `AMBIGUOUS_DEPOSIT` / `TXN_SUM_MISMATCH` |
| `OPEN` | a later run auto-matches (late booking) | `MATCHED` |
| `OPEN` | finance: match to a chosen deposit | `RESOLVED` (manual match) |
| `OPEN` | finance: dismiss with a required reason (e.g. booked as something other than a deposit) | `RESOLVED` (dismissed) |
| `MATCHED` / `RESOLVED` | run: deposit gone or amount changed, or payout gone from the mirror or its amount/status changed | `OPEN` + kind `DRIFT` |

Rules: payouts not yet paid are skipped, not queued. A deposit backs at most one
payout (partial unique on the matched deposit id, so tests run `migrate deploy`,
not `db push`). A matched or resolved row stores a snapshot of `{ depositId,
txnDate, totalCents }` and the payout net it matched, which is what makes drift
detectable. Every transition writes `IncomeAuditLog` in the same transaction. A
run is idempotent and holds a Postgres advisory lock, so the cron and a manual
"run now" cannot interleave. `window` (default 7 days) and `reconcileFrom`
(default: the oldest payout in the mirror) are injected through
`configureIncome()`, so they can be tuned without a code change. QuickBooks
history predates the store's (owner-confirmed), so every payout should have a
deposit to find: `NO_DEPOSIT` is always a real exception, and there is no bulk
dismiss.

**Exception queue** = rows in `OPEN`, grouped by kind. That is the whole queue.
`DRIFT` is the surviving form of the source's conflict queue.

**When it runs.** checkin cannot add a cron route: `/api/cron/*` live in the
frozen `legacy-authz-routes.txt`. Income's `runReconcile()` is called from the
existing `/api/cron/reconcile-shopify` handler after checkin's own reconcile. It
reads the same freshly synced mirror and costs no extra Aurora wake. A
`FINANCE` "run now" route covers the rest.

## 4. Roles: `FINANCE`, with board read

| Source guard | checkin | Why |
|---|---|---|
| `canAccessIncome` = org role `finance` (edge proxy bounces every other role) | **`FINANCE`** (#1817 / #1314) for every read and the resolve/run writes | 1:1 with the role expense introduces; ledger reconciliation is the bookkeeper's job |
| `requireFinanceOrManager` on conflict resolve | not carried | Dead in the source: the proxy rejects org managers before the route runs |
| (none) | **`BOARD`**: read-only on both screens | finance rule: reconciliation problems surface on the finance board |
| (none) | `SYSADMIN`: no access | Finance Ops rule excludes sysadmins (`[Unsettled]`); not widened here |

Reads stay narrow, as in expense. No viewer gate. **Gate:** income's B PR
references the `FINANCE` authorize token, so it follows L3's role PR.

## 5. Model names and collisions

| Model | Collides with | Port name |
|---|---|---|
| `AuditLog` | checkin's own `AuditLog` | **`IncomeAuditLog`**, `@@map("audit_log")` (owner-approved) |
| `PayoutReconciliation` (new) | none: checked against checkin, every `packages/*` schema and all eight Inventory app schemas | as is |

The dropped source models need no rename; none of them collided either. Actor
columns keep the source names `actorUserId` / `resolvedByUserId`. Neither is in
`SCOPABLE_FIELDS` (bare `userId` / `personId` / `actorId` are), so: **zero
scopeBindings, zero `OPT_OUT_PENDING_ROUTE` entries.** Values are checkin
`Person.id` from the injected principal, as in the base docs. Fresh `init`
migration: the source's two migrations describe tables that aren't ported.

## 6. Surface and routes (all registered in B)

Pages (Finance nav section tabs, gated `FINANCE`/`BOARD`): `income/payouts`
(list + detail with transactions and reconciliation state) and
`income/reconciliation` (the queue, with resolve).

| Route | Verb | Gate | Returns |
|---|---|---|---|
| `/api/income/payouts` | GET | FINANCE, BOARD | `IncomePayoutView[]` |
| `/api/income/payouts/[gid]` | GET | FINANCE, BOARD | `IncomePayoutView` + `IncomeBalanceTxnView[]` + `PayoutReconciliation` |
| `/api/income/reconciliation` | GET | FINANCE, BOARD | `PayoutReconciliation[]` (status `OPEN`) |
| `/api/income/reconciliation/count` | GET | FINANCE, BOARD | `IncomeReconciliationCount` |
| `/api/income/reconciliation/[id]/candidates` | GET | FINANCE | `IncomeQbDepositView[]` (live QB, ±window) |
| `/api/income/reconciliation/[id]/resolve` | POST | FINANCE | `PayoutReconciliation` |
| `/api/income/reconciliation/run` | POST | FINANCE | `IncomeReconciliationCount` |

Mirror and QB rows are not Prisma models, so the stripper would drop them. Each
needs a **synthetic classification** (the `CatalogItemCount` pattern, #1286 §5):
`IncomePayoutView`, `IncomeBalanceTxnView`, `IncomeQbDepositView`,
`IncomeReconciliationCount`. These go in B, and they are the main way this
boundary PR differs from the other lanes'. No audit-log route: the source has no
audit viewer either; add one when someone asks to read it.

## 7. Sensitivity

The plan expects donor PII here. The source does hold it: `ShopifyCustomer` has
email, billing address and phone. **The port does not,** because that model
isn't ported and the mirror port selects no customer columns. The loaded
history's buyer details sit in the mirror alongside the API's, under s-read's
existing access. Income's tiering:

- **`internal`**: all amounts and dates, `payoutGid`, deposit id and snapshot,
  status/kind, `actorUserId`/`actorUsername`/`resolvedByUserId`, free text
  (`reason`, `note`), audit `before`/`after`; every field of the four synthetic
  views.
- **`public`**: row `id` only.
- **No `pii`, no `secret`.** This holds only while two things hold, and B's
  security test pins both: the mirror port's column lists exclude customer
  fields, and the deposit adapter discards QB `Line[]`, `PrivateNote` and
  entity refs (QB deposit lines can name a customer). Widening either means
  re-tiering in its own boundary PR.

## 8. Phasing: three PRs, each based on `main`

1. **S: `packages/income/` only.** Schema (`PayoutReconciliation`,
   `IncomeAuditLog`) + fresh init migration; reconcile engine + transition
   table + resolve + audit; `contract.ts` (`IncomeAuth`, `PayoutMirror`,
   `QbDepositSource`, which takes `AccessTokenSource` from `packages/quickbooks`);
   route factories; pages/components rewritten from `PayoutsClient` /
   `PayoutDetailClient` / `ConflictsClient`; dev seed (one `OPEN NO_DEPOSIT` row
   stamped with the seeded `Org` id). Vitest unit tier plus the pg-test-harness
   DB tier against fake ports: every transition, idempotent re-run, drift,
   one-deposit-one-payout, a payout with no transactions, advisory lock. The DB
   tier skips silently without `DOCKER_HOST`. The body carries the §1
   disposition table as its port-diff. Depends on H3 vendoring
   `packages/quickbooks` (for the type only).
2. **B: boundary, alone, registry-first.** `@sensitivity` on the income schema,
   `generator security`, `security/registry/income.ts` with all seven §6 routes,
   the four synthetic classifications, the merge-list line, security tests
   (stripper over each view; the no-customer-column / no-QB-line pins of §7).
   Depends on S and on L3's `FINANCE` role PR.
3. **W: wiring.** Route + page stubs, `pageRegistry`, Finance nav tabs,
   `configureIncome()` via the `LIBRARIES` list (H2), the `PayoutMirror` adapter
   (three SELECTs in `shopifyRead/client.ts`), the shared `AccessTokenSource`
   binding (inert until QB-0), the one-line call in `cron/reconcile-shopify`.
   Flow tests: FINANCE sees and resolves (dismiss) the seeded row; BOARD reads but
   gets 403 on resolve/run; a non-finance persona gets 403 everywhere; run with
   the mirror unwired returns zero counts. The flow compose has no mirror and no
   QB, so the matching logic is covered by S's DB tier, not by flow tests.

The historic CSV load is an operator step, not a PR; it can run before or after
W (migration doc). QB-0 (L4) gates live matching, not any of these PRs.

**Crossings: none.** Income calls no other library and no library calls
income. Its two dependencies are host-provided (the mirror bridge, the QB token
source) and one shared package. The only cross-lane touch is the
`AccessTokenSource` location and `depositsSince`, both inside L4's QB-0 PR (§3).

## 9. Distillation at merge

Add to `docs/rules/finance-payments.md` (Procedure → Reconciliation); no new
register file:

- Every paid store payout is matched to exactly one ledger deposit, or is raised
  for finance with the reason. A deposit backs at most one payout. `[Decision]`
- Payout reconciliation only reads the ledger; it never writes or corrects an
  entry there. `[Decision — deliberate limit]`
- A payout or deposit that changes after it was reconciled reopens for finance;
  it is never silently re-matched. `[Decision — *Principle: people decide about people*]`
- Store history reaches the app only through the mirror; there is no in-app
  upload of store exports. `[Decision — deliberate limit]`
- Income keeps no buyer identity; who paid is read from the mirror where it is
  needed. `[Decision — *Principle: least privilege*]`

Mechanism (ports, cron hook, synthetic views) is deleted with this doc.

## Alternatives considered

- **Port the in-app CSV importers** and keep pre-cutover history in income's own
  tables. Rejected: the load happens once (owner decision), the conversion script
  already exists, and the in-app path would bring buyer PII, three importers and
  two CSV-only queues into the library for a single use.
- **Re-pull old history from the Shopify API** by moving s-read's cutover back.
  Rejected: the API does not reach back far enough (owner-confirmed), which is
  why the CSVs exist.
- **Fold into checkin's `lib/finance/reconcile.ts` as more `PaymentException`
  kinds.** That is less code, and it reads the same mirror. Rejected only because
  the plan fixes every Inventory app as its own library and database. Revisit if
  the owner prefers it; the engine in §3 moves over unchanged.
- **Reconcile per order against QB sales receipts.** Rejected: the bank sees
  payouts, and finance books one deposit per payout (owner-confirmed).
