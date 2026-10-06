# Income: porting `income-app` into checkin (delta design)

## Problem

Every few days Shopify pays the organization's store takings into the bank as
one lump, a payout, net of fees and refunds. Each payout has to appear in
QuickBooks as one deposit of the right amount. Today finance books them by
hand, so payouts older than about 90 days are already in QuickBooks and need
checking, while newer ones need booking. Nothing does either job today.
checkin already mirrors the store's orders and payouts, and it reconciles
orders against memberships and enrollments, but it never touches QuickBooks.
The retiring income application doesn't either: it is a CSV importer for the
same Shopify data, with a queue for re-imports that disagree.

## Objective

Every paid Shopify payout ends up tied to exactly one QuickBooks deposit. If
finance already booked it, the app finds that deposit and records the link. If
nobody has, and the payout is recent, the app creates the deposit. Anything
else appears in a finance queue that says why. Finance clears that queue inside
checkin, and every decision is audited.

## Executive summary

- **Finance** gets two screens under the Finance nav: payouts with their
  reconciliation state, and an exception queue for payouts that did not match a
  deposit. The board can read both.
- **The port is mostly retirement.** s-read already mirrors orders, payouts and
  balance transactions from the Shopify API, so income reads the mirror and
  keeps no Shopify data of its own. The source's CSV importers are not ported:
  the history the API can't reach is loaded into the mirror once, by the
  source's own conversion script (`1283_INCOME_INTEGRATION-migration.md`).
- **The QuickBooks side is net-new and matches before it creates.** The source
  has no QuickBooks code. Income uses the same rule as bulk donation (#1280 §7):
  line payouts up with existing deposits first. The newest payout finance booked
  by hand marks where the app takes over; the app creates deposits for unmatched
  payouts after it and sends unmatched ones before it to finance. There is no
  cutoff to set and nothing for anyone to do. That find-or-create is built once
  in `packages/quickbooks` for both lanes. Matching needs QB-0 and a deposit
  read; creating needs the QB-2 deposit write. Until QB-2 lands, finance keeps
  booking by hand and the match records those deposits.
- **Some items book to their own QuickBooks class.** Finance maps a Shopify
  item to a budget-owner bucket, checkin's table whose QuickBooks reference is a
  Class (owner decision; the same buckets bulk donation and expense use). A
  deposit the app creates splits the payout across those classes; unmapped
  items book at organization level.
- **Check, cash and grant income stay out of scope for good** (owner
  decision). They are pure QuickBooks work, and the system does not duplicate them.
- **Cost:** a four-model library on its own database, three read-only ports,
  and one call added to an existing daily cron. No pipeline crossings.

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

**Out of scope for good (owner decision):** check, cash and grant income. Finance books it
in QuickBooks directly; income has no record of it and never will. Those
deposits can land in the same bank account as payouts; §3's exclusions keep
them out of a payout's candidates when the amounts collide.

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
  orderLines(orderGids: string[]): Promise<MirrorOrderLine[]>   // shop_order_line: variant id, title, sku, qty, price, discount
  itemsSeen(): Promise<MirrorItem[]>                            // distinct variant id + latest title/sku, for the mapping screen
}
```

checkin-app binds it to five new SELECTs in `src/lib/shopifyRead/client.ts`,
reusing that module's pool: SELECT-only by grant, `min: 0`, fast idle reap, and
the "not wired → no-op" behaviour. The library opens no connection to the mirror
and never imports `s-ingest-core`; the mirror has no `generator security`, so
nothing of it enters the classification map. Column lists exclude
`customer_email` / `customer_name`. Income never needs to know who bought.

**The mirror port exposes where each row came from.** `MirrorPayout` and
`MirrorBalanceTxn` carry `source: "api" | "hand_loaded"`, read from the
provenance mark the mirror fix adds to the live `shop_*` tables (migration doc,
step 0). Payout detail and the reconciliation queue show it, so finance can tell
loaded history from Shopify data. Matching treats both the same. A loaded payout
whose id the script could not recover has no transactions, so it lands as
`TXN_SUM_MISMATCH` for finance rather than matching silently.

## 3. QuickBooks: match before create

Income applies the matching model the owner set for every lane that books to
QuickBooks (expense, bulk donation and in-kind), first worked out by bulk
donation for this problem (#1280 §7). Its rules are stated in full here: our
own unmatched records drive narrow searches, a QuickBooks entry is claimed by
one record at most, finance can exclude an entry for good, and more than one
candidate always goes to a person. Finance
books by hand today, so older payouts are already in QuickBooks and newer ones
are not. Posting by age alone would double-book what finance entered recently,
or skip what it hasn't entered yet. So every payout is **matched first**:

1. Look for an existing QuickBooks deposit for the payout (QB read path). The
   search is narrow and driven from our side: deposits into the payout's bank
   account, dated inside `[issuedAt, issuedAt + window]`, with amount = payout
   net, minus every deposit already claimed by another payout and every deposit
   finance has excluded. Old QuickBooks history is never walked.
2. **Found:** record its id and mark the payout reconciled. Post nothing.
3. **Not found, after the takeover line:** create the deposit (QB-2 write),
   keyed so a retry never books twice. **Gated on the mirror being
   newest-wins.** s-read's `projectOrders` / `projectPayouts` do not keep the
   newest version today: a backfill, bulk re-ingest or replay can revert a row to
   older state. A deposit created from a reverted payout would book wrong amounts,
   so step 3 stays off (the payout waits as `WAITING`) until that fix, owned
   outside the port, is deployed. Matching (steps 1, 2, 4) does not wait.
4. **Not found, before the line:** finance's queue. A gap among finance's own
   bookings is finance's to explain; the app never fills it.

**The takeover line is derived, never configured** (owner decision). It is the
date of the newest payout tied to a deposit the app did not create, i.e. one
finance booked by hand, found by matching or chosen by finance. Each run matches
every open payout first, then reads the line, then creates for what is after
it. Payouts finance had booked by go-live sit before the line; everything later
belongs to the app. No date to set, no switch to flip, no action from finance
beyond knowing the release went out. The line always falls inside the mirror's
reach, because the hand-booked payouts that set it are recent. Deposits the app
creates don't move it. If finance hand-books a newer payout anyway, step 1 finds
it and the line moves forward, which is harmless. With no hand booking matched
yet (for example before the deposit read works), there is no line and the app
creates nothing: it fails closed.

**Built once, in `packages/quickbooks`.** Steps 1 to 4 are one shared
find-or-create, used by income and bulk donation alike (plan decision), so the
line, the lookup and the retry key behave the same for both. Income supplies
the deposit it wants (date, net, lines, account), its key (the payout GID), its
current line, and its claimed and excluded deposit ids; the helper keeps no
state and answers *found*, *ambiguous*, *created*, *failed* or *before the
line*. Each lane derives its line the same way from its own records.
Owned by L4, alongside:

- **One connection.** checkin-app builds one `AccessTokenSource` (the
  Secrets-Manager read adapter) and injects the same instance into
  `configureExpense()`, `configureIncome()` and bulk donation's configure call.
  That requires the type to live in `packages/quickbooks`, so neither library
  imports the other. **Owner-approved; handed to L4 (QB-0).**
- **Read:** a windowed deposit read, `depositsBetween(from, to)` (Deposit
  `WHERE TxnDate BETWEEN …`), in the QB-0 PR. It replaces the `depositsSince`
  income asked for earlier, which would walk history. Income's adapter keeps only `{ id, txnDate, totalCents,
  depositToAccount }` and discards lines, memo and entity refs (§7).
- **Write:** the QB-2 deposit-create method. Expense's QB-2 only creates
  purchases and bills; bulk donation needs the same deposit write.

**The retry key.** The created deposit carries the payout GID in a field the
lookup in step 1 also matches on, and the call sends it as QuickBooks' request
id. A run that crashes after QuickBooks accepted the deposit, but before income
recorded it, finds that deposit on the next run and records it as found. Nothing
is booked twice, and income needs no separate outbox table: the reconciliation
row is the outbox.

**Rungs, and what works before each.** Before QB-0, the run no-ops. With QB-0
and the read, steps 1, 2 and 4 work; a payout that step 3 would create waits,
re-checked every run, and finance keeps booking by hand, which step 2 then
records. With QB-2, step 3 goes live. Income's S/B/W PRs wait on none of this.

### Reconciliation state machine: `PayoutReconciliation`

One row per paid payout, unique on `(orgId, payoutGid)`. Finance books exactly one
QuickBooks deposit per payout (owner-confirmed), so the match is one-to-one.
Plain status column with a guarded transition table; no xstate.

| From | Event | To |
|---|---|---|
| (none) | Σ txn net ≠ payout net | `OPEN` + `TXN_SUM_MISMATCH` (nothing is posted for numbers that don't add up) |
| (none), `WAITING` | exactly one deposit, neither claimed nor excluded, `amount = payout net`, date in `[issuedAt, issuedAt + window]` | `MATCHED` (nothing posted) |
| (none), `WAITING` | more than one candidate | `OPEN` + `AMBIGUOUS_DEPOSIT` |
| (none), `WAITING` | none found, payout after the line, deposit write available | create → `POSTED`, or `OPEN` + `POST_FAILED` |
| (none) | none found, payout after the line or no line yet, no deposit write yet | `WAITING` |
| (none) | none found, payout before the line, window elapsed | `OPEN` + `NO_DEPOSIT` |
| `OPEN` | a later run finds the deposit (late hand booking) | `MATCHED` |
| `OPEN` `POST_FAILED` | a later run, or finance's retry, creates it with the same key | `POSTED` |
| `OPEN` | finance: match to a chosen deposit | `RESOLVED` (manual match) |
| `OPEN` | finance: dismiss with a required reason | `RESOLVED` (dismissed) |
| `MATCHED` / `POSTED` / `RESOLVED` | deposit gone or amount changed, or payout gone from the mirror or its amount/status changed | `OPEN` + `DRIFT` |

Rules: payouts not yet paid are skipped, not queued. A deposit backs at most one
payout: a plain unique on `(orgId, depositId)`, where `deposit_id` is null
whenever a row holds no deposit. Postgres allows any number of nulls under a
plain unique, and unlike a partial index it survives `prisma db push`. The row records the deposit's origin, `matched` or `created`, and a
snapshot of `{ depositId, txnDate, totalCents }` plus the payout net, which is
what makes drift detectable. A drifted deposit is never edited by the app, even
one it created; finance decides. Every transition writes `IncomeAuditLog` in the
same transaction. A run is idempotent and holds a Postgres advisory lock, so the
cron and a manual "run now" cannot interleave. `window` (default 7 days) and
`reconcileFrom` (default: the oldest payout in the mirror) are injected through
`configureIncome()`; neither decides who books what. QuickBooks history predates the store's
(owner-confirmed), so `NO_DEPOSIT` is always a real exception, and there is no
bulk dismiss.

**Posting is automatic.** A payout that passes the steps above is created
without a per-deposit approval (owner-confirmed), as in bulk donation's drain. The control is the
queue: anything that doesn't add up, doesn't match cleanly or fails to post goes
to finance (finance rule: a control is a flag a person signs off).

**Exception queue** = rows in `OPEN`, grouped by kind. `DRIFT` is the surviving
form of the source's conflict queue. In the shared model's vocabulary, income's
`POSTED` is `CREATED`, `NO_DEPOSIT` is `BEFORE_LINE` and `AMBIGUOUS_DEPOSIT` is
`AMBIGUOUS`; `TXN_SUM_MISMATCH` and `DRIFT` are income's own.

### Exclusions: `IncomeQbMatchExclusion`

Finance can permanently remove a QuickBooks deposit from candidacy (owner
decision), with one click and a reason. The usual case for income is a check
or cash deposit (out of scope, above) whose amount and date collide with a payout
and keep it `AMBIGUOUS`.

- **Model:** `IncomeQbMatchExclusion { orgId, qbTxnId, reason, excludedByUserId, excludedAt }`
  (column `excluded_by_user_id`, following `actorUserId` / `resolvedByUserId`),
  unique on `(orgId, qbTxnId)`, `@@map("qb_match_exclusion")`. The shared model
  names it `QbMatchExclusion`, but every lane has one and the classification
  map merges by model name, so each lane prefixes it (§5).
- **Action:** from a payout's candidate list, finance excludes a deposit with a
  required reason. The exclusion is written with an audit row in the same
  transaction, and it is permanent: there is no undo route. A wrong exclusion is
  corrected by matching the payout to that deposit by hand, which the resolve
  action allows.
- **Effect:** excluded and claimed ids are the only QuickBooks-side state income
  keeps. Both are passed to the shared find-or-create on every run, and an
  `AMBIGUOUS` payout left with one candidate auto-matches on the next run.

**When it runs: one step inside `/api/cron/reconcile-shopify`, nothing at
boot.** checkin cannot add a cron route: `/api/cron/*` live in the frozen
`legacy-authz-routes.txt`. Income's `runReconcile()` is a try/catch step in the
existing prod `/api/cron/reconcile-shopify` handler, after checkin's own
reconcile. The step is idempotent (advisory lock, §3), capped per run, and returns
counts only (`IncomeReconciliationCount`): no payout ids, amounts or names in the
cron response. It reads the same freshly synced mirror and costs no extra Aurora
wake, so a new payout is booked within about a day. `configureIncome()` only
stores what it is given: no database or QuickBooks access at app start, no
recovery sweep, no schedule of its own. A `FINANCE` "run now" route and the
`POST_FAILED` retry cover anything urgent.

### Deposit lines and item categories

Certain items have to book to their own QuickBooks category (owner decision).
A QuickBooks category is a **budget-owner bucket**: checkin owns that table, its
QuickBooks reference is a **Class** id (owner decision), and the expense lane
builds it (#1280 §6). Income reuses it instead of keeping a second
list:

- **Bucket list:** income declares the same read port bulk donation does,
  `OwnerDirectory { list(): Promise<OwnerInfo[]> }`, bound by checkin to its
  table. Income keeps the bucket id as an opaque integer and never sees
  approvers.
- **Item mapping:** `IncomeItemCategory { orgId, variantId, budgetOwnerId }`,
  unique on `(orgId, variantId)` like every other income table, so a second org
  keeps its own mappings. `variantId` is Shopify's variant id, stable across
  title and SKU edits. Finance sets the mapping for the injected org on a screen
  listing every item the mirror has seen, with its current mapping; the routes
  and the deposit-line builder always read and write under that org. Unmapped items are the default, not an error: they book at
  organization level, which is no bucket, as in bulk donation.

**Building a created deposit.** The deposit goes to the bank account for the
payout's net. Its lines:

- each charge's amount is split across its order's lines by line amount
  (price × quantity − discount) and booked to each line's mapped bucket's Class, or
  organization-level income when unmapped;
- whatever the split leaves over books at organization level, so every
  charge's lines sum exactly to the charge;
- a refund is split the same way against the same order's lines, as negative
  lines;
- fees and adjustments book at organization level to their own accounts.

So the lines always sum to the payout net, and the deposit matches the bank.
**Assumption (owner fact):** shipping and tax are always $0. Treehouse ships
nothing, and its services are tax-free in Texas, so the remainder line carries
rounding only. There are no tax or shipping accounts, and the mirror port reads
no per-order tax or shipping columns. Anything unexpected in the remainder still
books at organization level. Account names (bank, organization-level income,
fees) are injected through `configureIncome()`. Mapping changes apply to deposits created
afterwards. The app never rebooks a deposit it has already created. A mapping
that points at an archived bucket stops that payout with `POST_FAILED` until
finance remaps it. Hand-booked deposits that the app only matched are not
checked against the mapping.

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
| `PayoutReconciliation`, `IncomeItemCategory` (new) | none: checked against checkin, every `packages/*` schema and all eight Inventory app schemas | as is |
| `QbMatchExclusion` (shared model's name) | the same model in expense and bulk donation | **`IncomeQbMatchExclusion`**, `@@map("qb_match_exclusion")` |

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
| `/api/income/items` | GET | FINANCE, BOARD | `IncomeItemView[]` (items seen + mapped bucket) |
| `/api/income/items/[variantId]/category` | PUT, DELETE | FINANCE | `IncomeItemCategory` (the injected org's mapping) |
| `/api/income/qb-exclusions` | GET | FINANCE, BOARD | `IncomeQbMatchExclusion[]` (the injected org's, newest first) |
| `/api/income/qb-exclusions` | POST | FINANCE | `IncomeQbMatchExclusion` (exclude a deposit, reason required) |

Mirror and QB rows are not Prisma models, so the stripper would drop them. Each
needs a **synthetic classification** (the `CatalogItemCount` pattern, #1286 §5):
`IncomePayoutView`, `IncomeBalanceTxnView`, `IncomeQbDepositView`,
`IncomeItemView`, `IncomeReconciliationCount`. The bucket picker reads the
bucket list route the expense lane registers with the bucket table; income adds
no route for it. These go in B, and they are the main way this
boundary PR differs from the other lanes'. Resolve takes one of three actions:
match to a chosen deposit, dismiss with a reason, or retry a `POST_FAILED`
create. The create path adds no route. No audit-log route: the source has no
audit viewer either; add one when someone asks to read it.

## 7. Sensitivity

The plan expects donor PII here. The source does hold it: `ShopifyCustomer` has
email, billing address and phone. **The port does not,** because that model
isn't ported and the mirror port selects no customer columns. The loaded
history's buyer details sit in the mirror alongside the API's, under s-read's
existing access. Income's tiering:

- **`internal`**: all amounts and dates, `payoutGid`, deposit id and snapshot,
  status/kind, `actorUserId`/`actorUsername`/`resolvedByUserId`, free text
  (`reason`, `note`), audit `before`/`after`, item mappings (`orgId`, `variantId`,
  `budgetOwnerId`), exclusions (`qbTxnId`, `reason`, `excludedByUserId`, `excludedAt`); every field of
  the five synthetic views.
- **`public`**: row `id` only.
- **No `pii`, no `secret`.** This holds only while two things hold, and B's
  security test pins both: the mirror port's column lists exclude customer
  fields, and the deposit adapter discards QB `Line[]`, `PrivateNote` and
  entity refs (QB deposit lines can name a customer). Widening either means
  re-tiering in its own boundary PR.
- **Outbound:** a deposit income creates carries the payout's amounts, the
  configured accounts, the bucket Classes and the payout GID, and nothing
  about who bought. Income
  never sends buyer identity to QuickBooks; S's tests pin the deposit it builds.

## 8. Phasing: three PRs, each based on `main`

1. **S: `packages/income/` only.** Schema (`PayoutReconciliation`,
   `IncomeItemCategory`, `IncomeQbMatchExclusion`, `IncomeAuditLog`) + fresh
   init migration; the
   deposit-line builder (§3) with its sum-to-net tests; reconcile engine + transition
   table + resolve + audit; `contract.ts` (`IncomeAuth`, `PayoutMirror`,
   `QbDepositSource`, which takes `AccessTokenSource` from `packages/quickbooks`,
   and `OwnerDirectory`);
   route factories; pages/components rewritten from `PayoutsClient` /
   `PayoutDetailClient` / `ConflictsClient`; dev seed (one `OPEN NO_DEPOSIT` row
   stamped with the seeded `Org` id). Vitest unit tier plus the pg-test-harness
   DB tier against fake ports: every transition, idempotent re-run, drift,
   one-deposit-one-payout, a payout with no transactions, advisory lock. The DB
   tier skips silently without `DOCKER_HOST`. The body carries the §1
   disposition table as its port-diff. Depends on H3 vendoring
   `packages/quickbooks` (for the type only). The schema carries the whole
   machine from the start (`origin`, and the `WAITING`, `POSTED` and
   `POST_FAILED` values), so B tiers every field once and the create path later
   touches no boundary file. In progress as #1862 (local `d1d935cf`): the
   read-only engine; it needs those additions.
2. **B: boundary, alone, registry-first.** `@sensitivity` on the income schema,
   `generator security`, `security/registry/income.ts` with every §6 route,
   the five synthetic classifications, the merge-list line, security tests
   (stripper over each view; the no-customer-column / no-QB-line pins of §7).
   Depends on S and on L3's `FINANCE` role PR.
3. **W: wiring.** Route + page stubs, `pageRegistry`, Finance nav tabs,
   `configureIncome()` via the `LIBRARIES` list (H2), the `PayoutMirror` adapter
   (five SELECTs in `shopifyRead/client.ts`), the `OwnerDirectory` binding to
   checkin's bucket table, the shared `AccessTokenSource` binding (inert until
   QB-0), the one-line call in `cron/reconcile-shopify`. Needs the expense
   lane's bucket-table PR first, as bulk donation's W does.
   Flow tests: FINANCE sees and resolves (dismiss) the seeded row; BOARD reads but
   gets 403 on resolve/run; a non-finance persona gets 403 everywhere; run with
   the mirror unwired returns zero counts. The flow compose has no mirror and no
   QB, so the matching logic is covered by S's DB tier, not by flow tests.

4. **Create path, a follow-up after L4 lands the shared find-or-create and the
   QB-2 deposit write, and after the mirror newest-wins fix is deployed (§3,
   step 3).** Writes go through the single create-only QuickBooks writer L4
   builds in `packages/quickbooks` (Deposit, field-allowlisted, key looked up
   before create, per-run cap). The Deposit write is owned by the QuickBooks lane
   (L4) and has no other owner today: #1272 §9's QB-2 writer list does not name
   it yet. `packages/income` only: the engine calls the helper
   instead of its own lookup, and step 3 goes live. No route, field or boundary
   change; the three PRs above already carry everything it needs.

The historic CSV load is an operator step, not a PR; it can run before or after
W, and only after the mirror provenance fix (migration doc, step 0). QB-0 gates live matching and QB-2 gates creating, not any of
these PRs.

**Crossings: none.** Income calls no other library and no library calls
income. Its dependencies are host-provided (the mirror bridge, the QB token
source, checkin's bucket table) and one shared package. Cross-lane touches: L3
builds the bucket table; L4's `packages/quickbooks` carries the
`AccessTokenSource` location, `depositsBetween`, the Class reader, the
deposit write, and the stateless find-or-create shared with the other lanes
(§3).

## 9. Distillation at merge

Add to `docs/rules/finance-payments.md` (Procedure → Reconciliation); no new
register file:

- Every paid store payout is matched to exactly one ledger deposit, or is raised
  for finance with the reason. A deposit backs at most one payout. `[Decision]`
- A payout is matched against the ledger before anything is created for it. The
  app creates a deposit only when none exists and the payout is newer than the
  newest one finance booked by hand; an older payout with no deposit goes to
  finance, never to an automatic entry. Where that line falls is derived from
  the ledger, never configured. `[Decision]`
- A retried create never books a payout twice. `[Decision]`
- A QuickBooks entry finance has excluded is never offered as a match again; an
  exclusion carries a reason and is not undone. `[Decision]`
- Income's matching runs only inside the existing daily reconcile step or on a
  finance request; it never runs at app start or on a schedule of its own.
  `[Decision]`
- The app never edits or deletes a ledger entry, including one it created.
  `[Decision — deliberate limit]`
- A payout or deposit that changes after it was reconciled reopens for finance;
  it is never silently re-matched. `[Decision — *Principle: people decide about people*]`
- Store history reaches the app only through the mirror; there is no in-app
  upload of store exports. `[Decision — deliberate limit]`
- Items finance has not mapped book at organization level; mapping an item is
  never required before a payout posts. A mapping change never rebooks a deposit
  already created. `[Decision]`
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
- **Create or skip by payout age alone.** Rejected: it double-books what finance
  entered by hand recently and skips what it hasn't entered yet. Matching first
  handles both (bulk donation's rule).
- **Reconcile per order against QB sales receipts.** Rejected: the bank sees
  payouts, and finance books one deposit per payout (owner-confirmed).
