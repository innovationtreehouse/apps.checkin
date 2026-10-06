# s-read-function

Pulls **orders**, **payouts**, and **balance transactions** from the Shopify Admin GraphQL
API into a dedicated Postgres database. Designed to run as a scheduled ECS task, but
every step runs locally first so the pipeline is proven before deployment.

Database, projection, and normalization logic live in the shared
[`@inventory/s-ingest-core`](../packages/s-ingest-core) package (which owns the Prisma
schema + migrations); this package holds the Shopify-API-facing read path. The
companion [`s-replay-function`](../s-replay-function) handles admin replay / watermark
operations over the same core.

## How it works

```
EventBridge (cron)  ─▶  handler  ─┬─ incremental sync (orders + payouts, updated_at cursor)
                                   └─ backfill (Bulk Operation lifecycle, from cutover date)
                                            │
   Shopify Admin GraphQL  ──fetch──▶  shopify_raw_event   (append-only log, never mutated)
                                            │  (separate, replayable step)
                                   loader / projection  ──upsert by GID──▶  shop_* live tables
```

- **`shopify_raw_event`** is an append-only diagnosis log. Every row records how it
  arrived via the `source` column (`BACKFILL` / `INCREMENTAL` / `HAND_LOADED` /
  `TEST_LOADED`), so synthetic rows stay distinguishable from real API data forever.
- **Live tables** (`shop_order`, `shop_order_line`, `shop_refund`, `shop_payout`,
  `shop_balance_transaction`) are keyed on **`(store_id, Shopify GID)`** and written
  with idempotent upserts — re-reading the API or re-injecting an event never
  duplicates. The `store_id` is part of the key because a Shopify GID is unique only
  within a shop, so multi-store is additive (no key migration needed). This upsert keying is
  what makes the pipeline **at-least-once-safe**: a re-invoke after a crash, or a replay,
  re-projects the same nodes and converges (the only non-idempotent hop in the fleet is the
  monitoring relay's SNS publish).
- Payout ↔ order association is a stored column on each balance transaction
  (`payout_gid` + `order_gid`), not a heuristic. All cents are **signed**, so refunds
  and negative adjustments within a payout need no special handling. The incremental
  balance-transaction pull filters on `processed_at` — verified (2025-07) to be the same
  instant as the node's `transactionDate`, which is the field the watermark advances on, so
  the filter axis matches the watermark axis (no skips, no full re-pull).

## Where to put credentials

### Local development
Copy `.env.example` to `.env` (git-ignored) and fill it in:

| Variable | What it is |
| --- | --- |
| `SHOPIFY_READ_DATABASE_URL` | Connection string for a **local Postgres**. |
| `SHOPIFY_SHOP` | `your-store.myshopify.com`. |
| `SHOPIFY_ADMIN_TOKEN` | Static Admin API access token (`shpat_...`). Local/legacy shortcut — see below. |
| `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET` | Dev Dashboard app credentials. Set these **instead of** `SHOPIFY_ADMIN_TOKEN` to have the process mint its own token (required for the deployed sync, since nobody is around to hand-paste a fresh one every ~24h). |
| `SHOPIFY_API_VERSION` | API version to pin, e.g. `2025-07`. |
| `STORE_ID` | Seed used **only** by offline `inject` (defaults to `SHOPIFY_SHOP`). Real syncs ignore it and derive `store_id` from the live store's `myshopifyDomain` (recorded in the `store` registry table); a mismatch is logged as a warning. |
| `CUTOVER_DATE` | ISO date — backfill starts here and moves forward. |

**Required Admin API scopes:**
- `read_orders` — orders, line items, money, refunds.
- `read_customers` — buyer email/name on orders.
- `read_shopify_payments_accounts` — access the `shopifyPaymentsAccount` object.
- `read_shopify_payments_payouts` — the `payouts` + `balanceTransactions` connections.

(The legacy umbrella `read_shopify_payments` has been split into the two granular
`read_shopify_payments_*` scopes above — you need both.) Add these to the app,
**release a new version**, and **install/update** it on the store for the scopes to
take effect.

**Getting the token (new Dev Dashboard apps).** Shopify has removed the legacy
"Develop apps → reveal Admin API access token" flow for many stores. Apps created in
the **Dev Dashboard** instead expose a **Client ID** and **Client Secret** (in the
app's **Settings** in the Dev Dashboard on Shopify), which you exchange for a
short-lived (~24h) Admin API access token via the client-credentials grant:

```bash
curl -X POST "https://<shop>.myshopify.com/admin/oauth/access_token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&client_id=<id>&client_secret=<secret>"
```

The response's `access_token` (an `shpat_…` value) goes into `SHOPIFY_ADMIN_TOKEN` for
**local testing** — quick, but it expires in ~24h so it's a dead end for anything
unattended.

> Legacy custom apps (stores that still offer "Develop apps" in the admin) instead
> show a static Admin API access token you can reveal once and paste into `.env`.

**For the deployed sync**, skip the static token: set `SHOPIFY_CLIENT_ID` +
`SHOPIFY_CLIENT_SECRET` instead and leave `SHOPIFY_ADMIN_TOKEN` unset. `shopify/client.ts`
then mints its own token via the client-credentials grant on first use, caches it
in-memory (refreshing a few minutes before its ~24h expiry so a warm container never
serves a request on an about-to-expire token), and on an unexpected `401` mid-run
(a warm container holding a token that's since expired or been rotated) invalidates the
cache and re-mints once before retrying. Precedence is static-token-first: if
`SHOPIFY_ADMIN_TOKEN` is set, it's always used verbatim and the client-credentials path
never runs — so a `.env` with a static token keeps working unchanged. The client id and
secret live in the app's Settings in the Dev Dashboard — never commit them or `.env`.

*(No refresh token or encrypted token DB — Shopify's client-credentials grant doesn't
issue one; renewing is just re-running the same client_id/client_secret exchange, so an
in-memory cache is the whole mechanism. #237)*

### Production
The same variable names are read from `process.env`; the code never calls an AWS API, so
the deploy platform injects the values from its own secret store. The shipped wiring — a
scheduled ECS Fargate task with `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET` (not a static
`SHOPIFY_ADMIN_TOKEN`) injected natively by the task definition — is in
[DEPLOY.md](DEPLOY.md). No secret is ever committed to the repo.

## Setup

```bash
npm install                                  # from the repo root (workspaces)
npm run db:generate -w @inventory/s-ingest-core   # generate the Prisma client
npm run db:deploy   -w @inventory/s-ingest-core   # apply migrations to the DB (uses core/.env)
```

The schema, migrations, and Prisma client are owned by `@inventory/s-ingest-core` — this
package consumes the generated client. See [DEPLOY.md](DEPLOY.md) for how migrations are
applied in deployment (the `s-read-<env>-migrate` task).

## Triggers

All run locally with no AWS dependency (they read `.env`):

```bash
npm run sync:incremental     # delta pull (orders + payouts) since the last watermark
npm run sync:backfill        # Bulk Operation backfill from CUTOVER_DATE forward
INJECT_ALLOW=1 npm run inject -- <fixture.json> --reason "<why>" [--test]   # load a hand-authored/fixture node
```

`inject` validates the node with the same Zod schema the API path uses, appends it
to `shopify_raw_event` tagged `HAND_LOADED` (or `TEST_LOADED` with `--test`), then
runs the loader so it flows into the live tables exactly like real data. Each live
row carries the same `source` stamp, and a later API re-read of the same GID
restamps it. This is also how batch/test infrastructure seeds matching raw events.

Guard rails: inject refuses to run without `INJECT_ALLOW=1` and a non-empty
`--reason`, and records the operator (`cli:<os user>`) and reason on an `ADMIN`
`sync_run` that the injected raw events link to. `--test` also forces each order's
`test` flag on (every checkin reader filters `test = false`) and is refused against
the production store, by `STORE_ID` or by the mirror's `store` registry. A fixture
file looks like:

```json
{ "objectType": "PAYOUT", "node": { "id": "gid://shopify/ShopifyPaymentsPayout/1", "...": "..." } }
```

## Tests

```bash
npm test
```

Covers raw→live projection idempotency, signed/negative balance transactions,
order status transitions (cancellation/refund), and watermark advancement.

## Operations & monitoring

> Full design (signals, tiered CloudWatch-backstop + DB-enrichment, watchdog/outbox/relay,
> fleet strategy, pricing): [MONITORING-PRD.md](MONITORING-PRD.md).


- **No self-overlap.** The sync must never run concurrently with itself — overlapping
  runs waste API budget and can contend on the same rows. Enforced **in code** by a
  per-store Postgres advisory lock (`withAdvisoryLock` → `ConcurrentRunError`, treated as a
  benign skip), so it holds under any runtime — ECS has no Lambda `reserved_concurrency`
  knob to lean on.
- **Stale-run reaper (built in).** On startup the handler relabels `sync_run` rows
  stuck in `RUNNING` past a staleness threshold to `ABANDONED` (a process killed by
  timeout/OOM). This is cosmetic — it touches no watermark or data; the next scheduled
  run self-heals via the watermark. Nothing is auto-reprojected.
- **Primary health signal: a freshness heartbeat,** not watermark lag. Alarm on
  `now − (latest COMPLETED sync_run.finishedAt)` exceeding a couple of cron intervals.
  This advances on every successful run, including empty ones, so it does **not**
  false-fire on a quiet store. (Watermark lag — `now − sync_state.lastUpdatedAtProcessed`
  — only moves when real records arrive, so use it only as a secondary per-store signal
  where there's a known activity cadence. Rationale: [MONITORING-PRD.md](MONITORING-PRD.md) §4.1.)

## Deployment

Shipped as a **scheduled ECS Fargate task** (infra#112), built from
[`Dockerfile`](Dockerfile) — not a Lambda. Terraform (infra `modules/s-read`) provisions
the AWS resources (cluster, sync/migrate task-defs, trigger Lambda + schedule, IAM,
secrets, log groups) and deliberately does **not** run schema migrations — those are a
separate migrate task ([FUTUREWORK.md](FUTUREWORK.md) §4 for the rationale). The invoke-only
admin security model is [FUTUREWORK.md](FUTUREWORK.md) §2; alarm wiring is §3.

**Ops runbook: [DEPLOY.md](DEPLOY.md)** — the ordered go-live checklist: Shopify app scopes,
DB bootstrap, secrets, first deploy via the `deploy-s-read` workflow, one-time backfill,
verification.

## Status / future work

See [FUTUREWORK.md](FUTUREWORK.md) for deferred items: poison-record skip-and-flag DLQ.
(Replay / reset-watermark / reingest-bulk admin operations, the stale-run reaper, and
programmatic token acquisition (#237) are **built** — see
[`s-replay-function`](../s-replay-function), the stale-run reaper above, and "Getting the
token" above.)

- Deployment: packaging ([`Dockerfile`](Dockerfile)), the manual deploy workflow
  (`.github/workflows/deploy-s-read.yml`), and the ops runbook ([DEPLOY.md](DEPLOY.md))
  are in this repo; the AWS resources (ECS/EventBridge/secrets) are infra#112 — the image
  lives on GHCR, not ECR.
- Cross-database de-duplication against `income-app` is **future work**; this
  function persists the identifiers income-app records (legacy order id, order name,
  payout id) so that reconciliation can be deterministic later.
- A webhook + nightly-poll hybrid is the documented end state.
