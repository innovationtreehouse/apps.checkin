# @checkin/monitoring-db

The **dedicated monitoring Postgres** layer — the DB-backed enrichment tier from
[`MONITORING-PRD.md`](../../s-read-function/MONITORING-PRD.md). Separate from
`@checkin/telemetry` so services that only *emit* don't pull in Prisma.

## Tables

- **`health_event`** — append-only incident log (never updated/deleted). The metric says
  *something is wrong*; this row says *what* (`kind` + structured `detail`).
- **`monitoring_outbox`** — the to-be-sent alert, written in the **same transaction** as
  its `health_event` (transactional outbox, PRD §5.3). `subject` + `summary` are the
  self-contained alert body the relay publishes to SNS.

## Who uses it

- **Watchdog** writes via `recordIncident()` — health_event + outbox in one transaction.
- **Relay** reads via `claimPending()` / `markSent()` / `markFailed()`.

```ts
import { prisma, recordIncident, IncidentKind, Severity } from "@checkin/monitoring-db";

await recordIncident(prisma, {
  service: "shopify-read",
  env: "prod",
  kind: IncidentKind.STALE,
  severity: Severity.CRITICAL,
  detail: { lastFinishedAt: "2026-06-09T10:00:00Z", staleAfterSeconds: 7200, correlationId },
  subject: "[prod] shopify-read has not completed a sync in 3h",
  summary: "No COMPLETED sync_run for shopify-read since 2026-06-09T10:00:00Z (threshold 2h). Runbook: …",
});
```

## Database setup

This package **owns its own migrations**, separate from `s-ingest-core`. It points at
`MONITORING_DATABASE_URL` (a different database from any watched service).

```bash
cp .env.example .env          # set MONITORING_DATABASE_URL
npm run db:generate           # prisma generate
npm run db:migrate            # local: prisma migrate dev
npm run db:deploy             # prod: prisma migrate deploy
```
