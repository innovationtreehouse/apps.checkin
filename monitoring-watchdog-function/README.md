# monitoring-watchdog-function

The **detection** half of the monitoring system (see
[`MONITORING-PRD.md`](../s-read-function/MONITORING-PRD.md)). A scheduled Lambda that reads
each service's sync freshness from the dedicated monitoring database, emits a CloudWatch
signal when a service is unhealthy, and records the rich "why" in that same database for the
relay to deliver.

> Companion: [`monitoring-relay-function`](../monitoring-relay-function/README.md) does
> delivery. This function never talks to SNS/Slack directly — it writes the outbox.

> **Freshness is push-based (review finding F7).** The watchdog used to hold a Postgres
> connection string to *every* watched service's financial database and read `sync_run`
> directly — making the monitor the highest-value target in the fleet. Now each service
> **pushes** its own run freshness into the monitoring DB's `service_heartbeat` table (see
> [`@checkin/monitoring-db`](../packages/monitoring-db)), and the watchdog reads only that.
> It holds **no credential** to any watched service's database; its blast radius is the
> monitoring DB alone.

## What it does, each run

1. Loads the **service registry** (`MONITORING_SERVICES`, one `{service, staleAfterSeconds}`
   per service). This is the **expected set** — "who should be reporting" — so a service
   that goes silent (stops pushing) is still flagged stale.
2. Reads `service_heartbeat` for those services from the monitoring DB **in one query**. Each
   row carries two independent signals (the producing service excludes `ADMIN` runs when it
   pushes, so an operator replay / reset-watermark can neither reset the health clock nor look
   like a pipeline fault):
   - freshness — `last_success_at` (newest COMPLETED data run)
   - latest failure — `last_failure_at` / `last_error` (newest FAILED/ABANDONED data run)
   Then it classifies (first match wins):
   - **Stale** (`now − last_success_at > staleAfterSeconds`, or no heartbeat row yet): emit
     `serviceError` **and** `recordIncident(STALE, CRITICAL)` (health_event + outbox, one txn).
   - **Erroring** (still fresh, but the latest failure is newer than the last success —
     runs are happening but failing): emit `serviceError` **and**
     `recordIncident(ERRORING, WARNING)`. This is the early warning that precedes staleness.
   - The metric (EMF → stdout) fires **first and unconditionally**, so a monitoring-DB
     outage can't suppress the signal. `serviceError` is the single metric for both STALE
     and ERRORING; the kind/severity that distinguishes them lives in `health_event`.
3. Emits `monitorHeartbeat` last — proof it ran to completion.

If the **monitoring DB itself** is unreachable, the run emits `dbUnreachable` (for the
monitor) and exits without its `monitorHeartbeat`; the missing-data alarm on that heartbeat
is the floor that catches a dead watchdog. There is no longer a per-service "DB unreachable"
incident — a service whose own DB is down stops pushing and surfaces as erroring → stale.

**Alert de-duplication.** The `health_event` is appended on every detection (the full
timeline), but the SNS **alert** is deduped: a persistent incident for the same
`(service, kind)` only re-enqueues an alert after `RENOTIFY_AFTER_SECONDS` (default 1h), so
an outage doesn't re-page every cron tick. The shared `correlationId` is carried onto the
alert (and the incident id = `health_event.id`) so a responder can pivot alert → logs.

Metric contract (from `@checkin/telemetry`): `serviceError`, `dbUnreachable`,
`monitorHeartbeat`, dimensions `{service, env}` only. Detail lives in `health_event`,
never in a metric.

## Configuration

| Env var | Purpose |
| --- | --- |
| `MONITORING_SERVICES` | JSON array registry `[{service, staleAfterSeconds}]` — see `.env.example` |
| `MONITORING_DATABASE_URL` | dedicated monitoring Postgres (health_event + outbox + service_heartbeat) — the **only** DB this function connects to |
| `MONITORING_ENV` | **required**, no default: `env` dimension, e.g. `prod` — must match the env services push under |
| `MONITOR_NAME` | `service` dimension on the heartbeat (default `monitoring-watchdog`) |
| `RENOTIFY_AFTER_SECONDS` | re-alert window for a persistent incident (default `3600`) |

Local: `cp .env.example .env && npm install && npm run run:once`.

---

## Terraform directions

> Terraform does not consume this repo yet. This is the spec to implement when it does —
> ideally as a reusable **"monitored Lambda" module** instantiated for both this function
> and the relay (PRD §6.4). Verify current CloudWatch rates (PRD §7).

### The reusable module (`modules/monitored_lambda`)

Inputs: `name`, `handler`, `schedule_expression`, `environment` (map), `secret_arns`
(list), `reserved_concurrency` (default 1), `log_retention_days` (default 30),
`alarm_sns_topic_arn`.

It should provision, per function:

- **`aws_lambda_function`** — `nodejs22.x` runtime, `handler = "src/handler.handler"` (after
  `npm run build`), packaged from `dist/` + `node_modules`.
- **`aws_cloudwatch_log_group`** — name `/aws/lambda/${name}`, **`retention_in_days = 30`**.
  Lambda's implicit log group never expires; log *ingestion* is the dominant cost (PRD §7),
  so this is the fleet cost lever — set it from day one.
- **`aws_lambda_function` `reserved_concurrent_executions = 1`** — no overlap (PRD §10).
- **`aws_cloudwatch_event_rule` + `_target`** — EventBridge cron, e.g.
  `schedule_expression = "rate(5 minutes)"`. Pick the interval so `staleAfterSeconds` is a
  couple of intervals (e.g. 5-min cron → 2h threshold tolerates many misses before paging).
- **IAM execution role** with:
  - `AWSLambdaBasicExecutionRole` (logs),
  - **`cloudwatch:PutMetricData`** is *not* needed — metrics go via EMF (logs). Just logs.
  - read/write access to the **monitoring DB only** (network / security-group reachability;
    credentials come from the secret store via `secret_arns`). Under the F7 push model the
    watchdog holds **no** credential to any watched service's database.
  - `secretsmanager:GetSecretValue` / `ssm:GetParameter` for the injected monitoring DB URL.

### This function's instantiation

```hcl
module "watchdog" {
  source              = "../modules/monitored_lambda"
  name                = "monitoring-watchdog"
  schedule_expression = "rate(5 minutes)"
  reserved_concurrency = 1
  log_retention_days  = 30
  alarm_sns_topic_arn  = aws_sns_topic.monitoring_alerts.arn
  environment = {
    MONITORING_ENV  = "prod"
    MONITOR_NAME    = "monitoring-watchdog"
    # MONITORING_SERVICES and MONITORING_DATABASE_URL injected from Secrets Manager
  }
  secret_arns = [aws_secretsmanager_secret.monitoring_db.arn]
}
```

---

## CloudWatch directions

All metrics arrive via **EMF**, extracted from this Lambda's log group into namespace
`Inventory/Monitoring` with dimensions `{service, env}`. Define these alarms (Terraform
`aws_cloudwatch_metric_alarm` / `aws_cloudwatch_composite_alarm`), all notifying the
`monitoring_alerts` SNS topic:

| Alarm | Metric / expression | `treat_missing_data` | Why |
| --- | --- | --- | --- |
| **Service unhealthy** (per service) | `serviceError{service,env} >= 1`, period = cron interval | `notBreaching` | A healthy service emits nothing; only a real incident raises it. The staleness *threshold* is decided in the watchdog, so the alarm is a simple presence check. Under F7 a service whose own DB is down stops pushing → surfaces here as erroring → stale (there is no per-service `dbUnreachable`). |
| **Monitoring DB unreachable** | `dbUnreachable{service="monitoring-watchdog",env} >= 1` | `notBreaching` | The watchdog couldn't reach the **monitoring** DB. (The relay emits the same metric under `service="monitoring-db"`; both mean "monitoring store down".) |
| **Watchdog dead** (the floor) | `monitorHeartbeat{service="monitoring-watchdog",env} < 1` for ~3 missed intervals | **`breaching`** | A dead watchdog emits nothing — its absence must page. Note a *skipped* (concurrent-overlap) run no longer emits a heartbeat, so the ~3-interval tolerance is what absorbs a benign overlap; sustained skips correctly trip this floor. This is the piece a naive design forgets (PRD §5.2). |
| **Monitoring-store down** (composite) | `aws_cloudwatch_composite_alarm` OR-ing the watchdog and relay `dbUnreachable` alarms into ONE page | n/a | Both monitors hitting the same store should page once, not twice (PRD §5.4). |

### Routing / SNS

All alarms publish to **one SNS topic** (`aws_sns_topic.monitoring_alerts`). SNS → Slack
is wired separately (out of scope here). The alarm name + description must be
**self-contained** (PRD §3.3): e.g.
`"[prod] monitoring-watchdog heartbeat missing > 15m → runbook: monitoring-watchdog-function/README.md"`.

### Runbook (per alarm)

- **Service unhealthy / stale** → check the latest `health_event` row for that service
  (kind + detail), then the service's own Lambda Errors/Duration and recent `sync_run`
  rows. The next scheduled run self-heals via the watermark; no data action needed. If the
  logs show a `clock skew` warning, a producer's heartbeat timestamp is in the future — the
  staleness age was clamped to 0; investigate the producer's clock.
- **Monitoring DB unreachable** → check RDS/Proxy health for the **monitoring** database
  (the only DB the watchdog connects to). Detection metrics still fire (EMF, not DB-backed),
  but incident enrichment/delivery pauses until it's back.
- **Watchdog dead** → check this Lambda's Errors/Duration and the EventBridge rule; a dead
  watchdog also means *no* service signals are trustworthy until it's back.
