# @inventory/telemetry

Fleet-wide **emission core** — the "standardize emission" layer from
[`MONITORING-PRD.md`](../../s-read-function/MONITORING-PRD.md) §6.1. Stateless and
dependency-light (no DB, no AWS SDK), so any of the ~50 Lambdas can import it to emit
health the same *shape*.

## What's here

- **`logger`** — minimal structured-JSON logger + `newCorrelationId()`. The fleet-wide
  canonical version; `@inventory/s-ingest-core` re-exports it. An `Error` in the fields
  is logged with its message and stack passed through `redactSecrets`.
- **`redactSecrets`** — strips credentials and personal data (query-string URLs, emails,
  auth headers, key=value secrets, token prefixes, opaque keys) from error text.
- **`metrics`** — CloudWatch metric emission via **Embedded Metric Format (EMF)**: one
  JSON line to stdout, extracted into a metric by CloudWatch Logs. No `PutMetricData`
  call, no extra IAM, works even when only the log stream is reachable.

## The metric contract (frozen — alarms key off these exact strings)

| Metric | Meaning | Alarm on missing data |
| --- | --- | --- |
| `serviceError` | a monitored service is unhealthy (why → `health_event`) | **not** breaching |
| `dbUnreachable` | a monitor couldn't reach a DB | **not** breaching |
| `monitorHeartbeat` | a monitor is alive | **breaching** (the floor) |

- Namespace: `Inventory/Monitoring`
- Dimensions: `{ service, env }` — and only these. A metric carries a number, never free
  text (PRD §4.2).

```ts
import { emitServiceError, emitMonitorHeartbeat, logger } from "@inventory/telemetry";

emitServiceError("shopify-read", "prod");        // service is unhealthy
emitMonitorHeartbeat("monitoring-watchdog", "prod"); // I'm alive
logger.warn("stale service detected", { service: "shopify-read", correlationId });
```
