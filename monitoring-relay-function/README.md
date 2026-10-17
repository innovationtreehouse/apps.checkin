# monitoring-relay-function

The **delivery** half of the monitoring system (see
[`MONITORING-PRD.md`](../s-read-function/MONITORING-PRD.md)). A scheduled Lambda that
drains the transactional outbox and publishes each self-contained alert to SNS.

> Companion: [`monitoring-watchdog-function`](../monitoring-watchdog-function/README.md)
> does detection and writes the outbox. This function only reads it.

## What it does, each run

1. `claimPending()` — oldest-first batch of `PENDING` `monitoring_outbox` rows.
2. For each: `publishAlert()` to SNS (`subject` + `summary` are already self-contained,
   PRD §3.3; `service`/`env`/`severity` ride along as sanitized SNS message attributes, with a
   hard per-publish timeout), then `markSent()`. A **transient** failure leaves the row
   `PENDING` (`attempts++`, `lastError`) for the next run — **idempotent, retried**. A
   **permanent** failure (malformed attribute, `AuthorizationError`, missing topic) or one
   that exhausts `RELAY_MAX_ATTEMPTS` moves the row to **`DEAD`** (dead-letter) so a poison
   row can't wedge the oldest-first drain. The `health_event` preserves the incident either way.
3. If any `DEAD` rows exist for this env, emit `serviceError` (service = `MONITOR_NAME`) — the
   relay is alive but **unhealthy** (carrying undeliverable alerts). Self-clears when the DLQ
   drains to 0.
4. Emits `monitorHeartbeat` last — proof it ran. (A run that *skips* on a concurrent-lock
   overlap does **not** heartbeat; the lock-holder does.)

If the monitoring DB itself is unreachable, it emits `dbUnreachable` (service =
`monitoring-db`), still emits its heartbeat, and surfaces the error.

### Delivery semantics

Delivery is **at-least-once**. The advisory lock prevents *concurrent* double-publish, but a
crash between a successful SNS publish and `markSent` re-publishes that row next run, and SNS
standard-topic Publish is not idempotent — so a rare **duplicate alert** is possible. This is
accepted (an SNS FIFO topic + dedup id is the lever if duplicates ever become noisy); the
`healthEventId` + correlation trailer let a responder collapse duplicates by eye.

> The rest of the pipeline (s-read sync, s-replay) is also at-least-once but made **safe by
> idempotent upserts** keyed on `(store_id, shopify_gid)` — re-processing converges. The
> relay's SNS egress is the one non-idempotent hop in the fleet.

> **SNS → Slack is out of scope here.** Both alert paths terminate at the one SNS topic;
> the SNS→Slack subscriber is wired separately.

## Configuration

| Env var | Purpose |
| --- | --- |
| `SNS_TOPIC_ARN` | topic all alerts publish to |
| `MONITORING_DATABASE_URL` | dedicated monitoring Postgres (outbox) |
| `MONITORING_ENV` | **required**, no default: `env` dimension, e.g. `prod` |
| `MONITOR_NAME` | `service` dimension on the heartbeat + the unhealthy `serviceError` (default `monitoring-relay`) |
| `RELAY_BATCH_LIMIT` | max rows per run (default 50) |
| `RELAY_MAX_ATTEMPTS` | failed deliveries reaching this attempt count are dead-lettered (default 5) |
| `AWS_REGION` | SDK region (auto in Lambda) |

**Operator recovery:** after fixing the root cause of dead-lettered alerts (e.g. SNS topic
permissions), run `npm run requeue-dead` to move all `DEAD` rows for this env back to
`PENDING` (the next run retries them), or `npm run requeue-dead -- <outboxId>` for one row.

Local: `cp .env.example .env && npm install && npm run run:once`.

---

## Terraform directions

> Terraform does not consume this repo yet. Implement with the **same reusable
> "monitored Lambda" module** as the watchdog (see
> [`monitoring-watchdog-function/README.md`](../monitoring-watchdog-function/README.md)
> for the module spec: Lambda + log group with `retention_in_days = 30` + reserved
> concurrency 1 + EventBridge cron + IAM). Verify current CloudWatch rates (PRD §7).

This function's instantiation differs from the watchdog only in its IAM and env:

```hcl
module "relay" {
  source               = "../modules/monitored_lambda"
  name                 = "monitoring-relay"
  schedule_expression  = "rate(1 minute)"   # deliver promptly; idempotent so frequent is fine
  reserved_concurrency = 1
  log_retention_days   = 30
  alarm_sns_topic_arn  = aws_sns_topic.monitoring_alerts.arn
  environment = {
    MONITORING_ENV = "prod"
    MONITOR_NAME   = "monitoring-relay"
    SNS_TOPIC_ARN  = aws_sns_topic.monitoring_alerts.arn
    # MONITORING_DATABASE_URL injected from Secrets Manager
  }
  secret_arns = [aws_secretsmanager_secret.monitoring_db.arn]
}
```

Extra IAM this function needs beyond the base module:

- **`sns:Publish`** on `aws_sns_topic.monitoring_alerts` — its only egress.
- read/write the monitoring DB (to claim and mark outbox rows).
- **No** Slack/webhook secret — delivery stops at SNS.

### The SNS topic (shared, define once)

```hcl
resource "aws_sns_topic" "monitoring_alerts" {
  name = "monitoring-alerts"
}
# SNS -> Slack subscription is added separately, out of scope for this repo.
```

---

## CloudWatch directions

The relay's own alarms (in addition to the service/DB alarms defined in the watchdog
README — all on the same `Inventory/Monitoring` namespace, `{service, env}` dims):

| Alarm | Metric / expression | `treat_missing_data` | Why |
| --- | --- | --- | --- |
| **Relay dead** (the floor) | `monitorHeartbeat{service="monitoring-relay",env} < 1` for ~3 missed intervals | **`breaching`** | A dead relay delivers nothing — including no "DB down" — so its liveness must be asserted by absence detection, independent of the watchdog (PRD §5.2 row 3). A *skipped* (concurrent-overlap) run no longer heartbeats, so the ~3-interval tolerance absorbs a benign overlap; sustained skips trip the floor. |
| **Relay unhealthy (dead-letters)** | `serviceError{service="monitoring-relay",env} >= 1` | `notBreaching` | The relay is alive but holding `DEAD` (undeliverable) alerts. Page; clears automatically once the DLQ is drained/requeued. |
| **Monitoring DB unreachable** | `dbUnreachable{service="monitoring-db",env} >= 1` | `notBreaching` | The relay (and watchdog) can't reach the monitoring store. Fold into the composite "DB down" page. |

### Runbook

- **Relay dead** → check this Lambda's Errors/Duration and its EventBridge rule. Alerts are
  not being delivered even though incidents may be recorded; the outbox backs up safely
  (rows stay `PENDING`) and drains once the relay recovers — nothing is lost.
- **Monitoring DB unreachable** → check the monitoring RDS/Proxy. Detection metrics still
  fire (they're EMF, not DB-dependent), but enrichment/delivery is paused until it's back.
- **Relay unhealthy (dead-letters)** → alerts have been moved to `DEAD` after permanent or
  repeated publish failures; inspect `last_error` on those rows and SNS topic permissions/ARN.
  After fixing the cause, `npm run requeue-dead` (or `-- <id>`) returns them to `PENDING`.
- **Outbox backing up** (optional alarm) → a high count of old `PENDING` rows means SNS
  publishes are failing transiently; check `last_error` on the rows and SNS topic permissions.
