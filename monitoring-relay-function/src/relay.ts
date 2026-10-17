/**
 * Relay orchestration.
 *
 * Drains PENDING outbox rows and publishes each to SNS, marking it SENT only after a
 * successful publish. Delivery is idempotent and retried: a failed publish leaves the row
 * PENDING (attempts++/lastError) for the next run; the health_event preserves the incident
 * regardless. Emits its own heartbeat so a dead relay is caught by the missing-data floor.
 *
 * Concurrency (F19): the whole claim→publish drain runs under a Postgres advisory lock, so
 * two overlapping invocations cannot read the same PENDING batch and double-publish — the
 * single-flight guarantee is defended in code, not just by reserved concurrency = 1. A second
 * invocation that can't take the lock skips cleanly (without a heartbeat — the lock-holder
 * asserts liveness).
 *
 * Delivery is AT-LEAST-ONCE. The advisory lock prevents concurrent double-publish, but not a
 * crash between a successful SNS publish and `markSent`: that row stays PENDING and is
 * published again next run. SNS standard-topic Publish is not idempotent, so a rare duplicate
 * alert is possible. This is accepted (not worth an SNS FIFO topic + dedup id): the
 * `healthEventId`/correlation trailer lets a responder collapse duplicates by eye.
 *
 * Undeliverable alerts: a permanent failure (or one that exhausts RELAY_MAX_ATTEMPTS) is
 * moved to the DEAD dead-letter state instead of retrying forever — a poison row can't wedge
 * the oldest-first drain. While any DEAD rows exist the relay reports itself unhealthy via a
 * `serviceError` metric (it stays alive/heartbeating); an operator clears them with
 * `requeueDead` once the cause is fixed.
 */
import { logger, newCorrelationId, emitMonitorHeartbeat, emitDbUnreachable, emitServiceError } from "@checkin/telemetry";
import {
  prisma,
  claimPending,
  markSent,
  markFailed,
  countDead,
  withAdvisoryLock,
  ConcurrentRunError,
} from "@checkin/monitoring-db";
import { publishAlert, isPermanentSnsError } from "./sns.js";
import type { RelayConfig } from "./config.js";

/** The `service` dimension used when the *monitoring* DB itself is the thing that's down. */
const MONITORING_DB = "monitoring-db";

export async function runRelay(
  cfg: RelayConfig,
): Promise<{ delivered: number; failed: number; deadLettered?: number; skipped?: boolean }> {
  let result: { delivered: number; failed: number };
  try {
    // Hold the drain lock across claim AND publish so a concurrent relay can't grab the same
    // PENDING rows. The lock query, the claim, and the publishes all run inside it.
    result = await withAdvisoryLock(`relay-drain:${cfg.env}`, () => drain(cfg));
  } catch (err) {
    if (err instanceof ConcurrentRunError) {
      // Another invocation owns the drain — skip WITHOUT a heartbeat. The lock-holder asserts
      // liveness when it completes; the missing-data floor tolerates a few missed intervals for
      // a benign overlap. Heartbeating on every skip would mask chronic overlap (a stuck holder
      // draining nothing) as "alive". Mirrors the watchdog's skip path.
      logger.warn("relay skipped: another invocation holds the drain lock (no heartbeat emitted)", { env: cfg.env });
      return { delivered: 0, failed: 0, skipped: true };
    }
    // Any other failure (including failing to acquire the lock) means the monitoring DB is
    // unreachable. Emit the dependency-light metric, still assert liveness, then surface it.
    emitDbUnreachable(MONITORING_DB, cfg.env, { err: err instanceof Error ? err.message : String(err) });
    emitMonitorHeartbeat(cfg.monitorName, cfg.env);
    logger.error("relay run failed (monitoring DB unreachable?)", { err });
    throw err;
  }

  // The relay is alive (heartbeat below) but UNHEALTHY if any alert is dead-lettered — those
  // are undeliverable until an operator intervenes. Report that as serviceError on the relay's
  // own dimension (self-clears when the DLQ drains to 0). Deliberately NOT routed through the
  // outbox: an alert about the relay, drained by the relay, would loop.
  const deadLettered = await reportDeadLetterHealth(cfg);

  emitMonitorHeartbeat(cfg.monitorName, cfg.env);
  logger.info("relay run complete", { delivered: result.delivered, failed: result.failed, deadLettered });
  return { ...result, deadLettered };
}

/** Emit serviceError if the dead-letter set is non-empty. Best-effort; never fails the run. */
async function reportDeadLetterHealth(cfg: RelayConfig): Promise<number> {
  try {
    const dead = await countDead(prisma, cfg.env);
    if (dead > 0) {
      emitServiceError(cfg.monitorName, cfg.env, { deadCount: dead, reason: "outbox dead-letter non-empty" });
      logger.warn("relay holding dead-lettered alerts — undeliverable until requeued", { deadCount: dead });
    }
    return dead;
  } catch (err) {
    // Don't let a count failure mask an otherwise-successful drain; the heartbeat still fires.
    logger.error("failed to read dead-letter count", { err });
    return 0;
  }
}

/** Claim a batch and publish each alert to SNS. Runs while the drain lock is held. */
async function drain(cfg: RelayConfig): Promise<{ delivered: number; failed: number }> {
  const pending = await claimPending(prisma, cfg.batchLimit);

  let delivered = 0;
  let failed = 0;
  for (const alert of pending) {
    const correlationId = newCorrelationId();
    try {
      await publishAlert(cfg.snsTopicArn, alert);
      await markSent(prisma, alert.id);
      delivered++;
      logger.info("alert delivered", {
        outboxId: String(alert.id),
        service: alert.service,
        incidentCorrelationId: alert.correlationId,
        correlationId,
      });
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      const permanent = isPermanentSnsError(err);
      await markFailed(prisma, alert.id, msg, {
        attempts: alert.attempts,
        maxAttempts: cfg.maxAttempts,
        permanent,
      }).catch((e) =>
        logger.error("failed to mark outbox row failed", { outboxId: String(alert.id), err: e, correlationId }),
      );
      const willDeadLetter = permanent || alert.attempts + 1 >= cfg.maxAttempts;
      logger.error(willDeadLetter ? "alert delivery failed; dead-lettered" : "alert delivery failed; will retry next run", {
        outboxId: String(alert.id),
        service: alert.service,
        attempts: alert.attempts + 1,
        maxAttempts: cfg.maxAttempts,
        permanent,
        deadLettered: willDeadLetter,
        err,
        correlationId,
      });
    }
  }
  return { delivered, failed };
}
