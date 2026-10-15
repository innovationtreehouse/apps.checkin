# s-replay-function

Admin operations for the Shopify ingestion pipeline. A **pure database consumer** —
it never calls Shopify, so it needs no Shopify credentials. Shares all DB/projection
logic with `s-read-function` via [`@inventory/s-ingest-core`](../packages/s-ingest-core),
so a replay projects **identically** to live ingestion.

Three idempotent operations:

- **`replay`** — re-project raw events from the append-only `shopify_raw_event` log into
  the live tables. Use after a projection-logic fix, or to repair live-table divergence.
  No Shopify calls. Projection commits **row-by-row**, so a replay that fails mid-stream
  leaves a partial (but valid) projection; the FAILED `sync_run` records how far it got
  (`processed` / `distinctGids` / `lastCommittedId`). Re-running is safe and converges, but
  restarts from the beginning — there is no resume.
- **`reset-watermark`** — move (or clear) `sync_state` so the next scheduled run of
  `s-read-function` re-pulls a range from Shopify. Safe because re-pulls upsert by GID.
- **`reingest-bulk`** — re-reassemble and re-project the stored verbatim bulk exports (no
  Shopify calls). Use after a reassembly-logic fix to repair backfilled orders; watermarks
  untouched.

All three are safe to run repeatedly and are recorded as `sync_run` rows with kind `ADMIN`.

### Idempotency & delivery

Every projection is an **idempotent upsert** keyed on `(store_id, shopify_gid)` (refunds on
`(store_id, refund_gid)`) over the append-only log — the same at-least-once-safe model as the
read path ([`s-read-function`](../s-read-function/README.md#how-it-works)). No external egress
here; the one non-idempotent hop in the fleet is the monitoring relay's SNS publish.

## Local

`--reason` is REQUIRED on every command (audit); `--actor` defaults to `cli:<os-user>`.

```bash
cp .env.example .env          # SHOPIFY_READ_DATABASE_URL only — no Shopify creds
npm run replay         -- --reason "<why>" [--actor <id>] [--object ORDER] [--gid <gid>] [--since <iso>] [--store <id>] [--all]
npm run reset-watermark -- --reason "<why>" [--actor <id>] [--object ORDER] [--to <iso>] [--store <id>] [--all]
npm run reingest-bulk  -- --reason "<why>" [--actor <id>] [--since <iso>] [--bulk <operationId>] [--store <id>] [--all]
```

`reset-watermark` with no `--to` clears the watermark (next sync re-pulls from the
cutover date).

A command with no narrowing filter (replay: `--object`/`--gid`/`--since`; reset-watermark:
`--object`; reingest-bulk: `--since`/`--bulk`) acts on the whole store and is refused
unless `--all` is passed.

## Deployment

A **separate** deployable from `s-read-function` (its own IAM boundary and failure
domain). **Invoke-only** — no EventBridge schedule and
**no public endpoint**; triggered by `aws lambda invoke` under an IAM ops role. Runtime DB
creds are **DML-only** — it never migrates. See `../s-read-function/FUTUREWORK.md` for the
full security model and `../s-read-function/MONITORING-PRD.md` for the broader picture.

`actor` and `reason` are REQUIRED in every payload (audit); the event schema is `.strict()`,
so unknown keys are rejected. A payload with none of its mode's narrowing filters (replay:
`objectType`/`gid`/`since`; reset-watermark: `objectType`; reingest-bulk:
`since`/`bulkOperationId`) is refused unless it carries `"scope": "all"`.

```jsonc
// example invoke payloads
{ "mode": "replay", "objectType": "ORDER", "since": "2026-01-01T00:00:00Z", "actor": "ops:jane", "reason": "reproject after refund fix" }
{ "mode": "reset-watermark", "objectType": "PAYOUT", "to": null, "actor": "ops:jane", "reason": "force re-pull of payouts" }
{ "mode": "reingest-bulk", "since": "2026-01-01T00:00:00Z", "actor": "ops:jane", "reason": "repair backfill after reassembly fix" }
{ "mode": "replay", "scope": "all", "actor": "ops:jane", "reason": "full rebuild of every projection" }
```

> The sibling references below (`../s-read-function/...`) assume the Shopify functions
> co-migrate; update them if this package is relocated on its own.
