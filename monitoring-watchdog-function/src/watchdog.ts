/**
 * Watchdog orchestration.
 *
 * Freshness is PUSH-based (F7): each service writes its own run outcome into the dedicated
 * monitoring DB's `service_heartbeat` table; the watchdog READS those rows in one query
 * rather than connecting to each service's financial database. For every registered service
 * it then decides staleness (no recent success) or erroring (recent runs are failing), and
 * on any unhealthy condition emits a (dependency-light) CloudWatch metric AND records a rich
 * incident in the monitoring DB. The metric is the floor that survives a monitoring-DB
 * outage; the health_event/outbox carry the "why" and drive the alert.
 *
 * STALE takes precedence over ERRORING: with no recent success at all the pipeline is
 * effectively down (CRITICAL); ERRORING is the earlier WARNING state where runs still
 * succeed within the window but newer runs have begun to fail. A service with no heartbeat
 * row at all (registered but never reported) is stale with a null age — same as the old
 * probe's "no COMPLETED run on record".
 *
 * Emission order matters: the metric (EMF → stdout) fires FIRST and unconditionally, so a
 * monitoring-DB failure can't suppress the signal. recordIncident is best-effort on top.
 */
import {
  logger,
  newCorrelationId,
  emitServiceError,
  emitDbUnreachable,
  emitMonitorHeartbeat,
} from "@checkin/telemetry";
import {
  prisma,
  recordIncident,
  readServiceHeartbeats,
  withAdvisoryLock,
  ConcurrentRunError,
  IncidentKind,
  Severity,
  type IncidentInput,
  type ServiceFreshness,
} from "@checkin/monitoring-db";
import type { ServiceEntry, WatchdogConfig } from "./registry.js";

/** The newest failed/abandoned run, as the erroring check consumes it. */
export interface ServiceFailure {
  failedAt: Date;
  error: string | null;
}

export interface FreshnessVerdict {
  stale: boolean;
  ageSeconds: number | null; // null = no COMPLETED run ever
  /** lastFinishedAt is in the future (producer clock skew) — a negative raw age was clamped. */
  clockSkew?: boolean;
}

/** Pure staleness decision — easy to unit-test without a database. */
export function evaluateFreshness(
  lastFinishedAt: Date | null,
  staleAfterSeconds: number,
  now: number,
): FreshnessVerdict {
  if (!lastFinishedAt) return { stale: true, ageSeconds: null };
  const rawAge = Math.round((now - lastFinishedAt.getTime()) / 1000);
  // A negative age means lastFinishedAt is in the future — producer clock skew. Don't let it
  // silently read as "comfortably fresh": clamp to 0 (still treated as fresh, since a run that
  // just finished isn't stale) and flag it so the caller can surface the skew rather than
  // masking a service that might actually be falling behind.
  if (rawAge < 0) return { stale: false, ageSeconds: 0, clockSkew: true };
  return { stale: rawAge > staleAfterSeconds, ageSeconds: rawAge };
}

export interface ErrorVerdict {
  erroring: boolean;
  /** The failure that triggered the verdict (only populated when erroring). */
  failedAt: Date | null;
  error: string | null;
}

/**
 * Pure erroring decision — easy to unit-test without a database. A service is "erroring"
 * when its most recent failed/abandoned run is newer than its last successful run: runs
 * ARE happening, but failing. This is the early-warning state that precedes staleness.
 *
 * A service that has never completed a run is owned by the staleness check (it is stale
 * with a null age), not this one — so a missing last-success returns not-erroring here to
 * avoid double-firing on the same underlying problem.
 */
export function evaluateErroring(
  lastFinishedAt: Date | null,
  latestFailure: ServiceFailure | null,
): ErrorVerdict {
  if (!latestFailure || !lastFinishedAt) return { erroring: false, failedAt: null, error: null };
  const erroring = latestFailure.failedAt.getTime() > lastFinishedAt.getTime();
  return {
    erroring,
    failedAt: erroring ? latestFailure.failedAt : null,
    error: erroring ? latestFailure.error : null,
  };
}

/** Record an incident, swallowing (but logging) a monitoring-DB failure — the metric already fired. */
async function safeRecord(input: IncidentInput, correlationId: string): Promise<void> {
  try {
    const { suppressed } = await recordIncident(prisma, input);
    if (suppressed) {
      // Health_event still recorded; the alert was deduped against a recent one (alert-storm guard).
      logger.info("incident recorded; alert suppressed (recent duplicate)", {
        service: input.service,
        kind: input.kind,
        correlationId,
      });
    }
  } catch (writeErr) {
    logger.error("failed to record incident (monitoring DB may be down)", {
      service: input.service,
      kind: input.kind,
      err: writeErr,
      correlationId,
    });
  }
}

async function checkOne(
  entry: ServiceEntry,
  freshness: ServiceFreshness,
  env: string,
  now: number,
  renotifyAfterSeconds: number,
): Promise<boolean> {
  const correlationId = newCorrelationId();
  {
    const { lastFinishedAt, latestFailure } = freshness;
    const { stale, ageSeconds, clockSkew } = evaluateFreshness(lastFinishedAt, entry.staleAfterSeconds, now);
    const last = lastFinishedAt ? lastFinishedAt.toISOString() : "never";

    if (clockSkew) {
      // Visible, not silent: a future lastFinishedAt could otherwise mask real staleness.
      logger.warn("service heartbeat is in the future (producer clock skew?) — age clamped to 0", {
        service: entry.service,
        lastFinishedAt: last,
        correlationId,
      });
    }

    // STALE (no recent success) takes precedence over ERRORING (recent success, newer failures).
    if (stale) {
      emitServiceError(entry.service, env, { correlationId });
      const ageStr = ageSeconds === null ? "no COMPLETED run on record" : `${ageSeconds}s ago`;
      await safeRecord(
        {
          service: entry.service,
          env,
          kind: IncidentKind.STALE,
          severity: Severity.CRITICAL,
          detail: { lastFinishedAt: last, ageSeconds, staleAfterSeconds: entry.staleAfterSeconds, correlationId },
          correlationId,
          renotifyAfterSeconds,
          subject: `[${env}] ${entry.service} sync is stale`,
          summary:
            `${entry.service} (${env}) last COMPLETED a sync ${ageStr} (last: ${last}); ` +
            `threshold is ${entry.staleAfterSeconds}s. The pipeline may be down, erroring, or timing out. ` +
            `Runbook: monitoring-watchdog-function/README.md.`,
        },
        correlationId,
      );
      logger.warn("service stale", { service: entry.service, ageSeconds, correlationId });
      return true;
    }

    // Still fresh, but is the most recent run failing? Catch it before the staleness window lapses.
    const { erroring, failedAt, error } = evaluateErroring(lastFinishedAt, latestFailure);
    if (erroring) {
      emitServiceError(entry.service, env, { correlationId });
      const failedStr = failedAt ? failedAt.toISOString() : "unknown";
      // Service-supplied error text is untrusted: collapse newlines/control chars before it
      // lands in the operator-facing alert summary (log-forging / markdown-injection guard).

      const errExcerpt = error ? ` Last error: ${error.replace(/[\x00-\x1f\x7f]+/g, " ").slice(0, 300)}.` : "";
      await safeRecord(
        {
          service: entry.service,
          env,
          kind: IncidentKind.ERRORING,
          severity: Severity.WARNING,
          detail: {
            lastFinishedAt: last,
            latestFailureAt: failedStr,
            error: error ?? null,
            ageSeconds,
            staleAfterSeconds: entry.staleAfterSeconds,
            correlationId,
          },
          correlationId,
          renotifyAfterSeconds,
          subject: `[${env}] ${entry.service} sync is erroring`,
          summary:
            `${entry.service} (${env}) has a failing sync run more recent than its last success ` +
            `(failed ${failedStr}; last COMPLETED ${last}).${errExcerpt} ` +
            `It is not yet stale (threshold ${entry.staleAfterSeconds}s) — investigate before it goes stale. ` +
            `Runbook: monitoring-watchdog-function/README.md.`,
        },
        correlationId,
      );
      logger.warn("service erroring", { service: entry.service, failedAt: failedStr, ageSeconds, correlationId });
      return true;
    }

    logger.info("service healthy", { service: entry.service, ageSeconds, correlationId });
    return false;
  }
}

/** A service registered but with no heartbeat row yet — treated as stale with a null age. */
const NEVER_REPORTED: ServiceFreshness = { lastFinishedAt: null, latestFailure: null };

export async function runWatchdog(
  cfg: WatchdogConfig,
): Promise<{ checked: number; incidents: number; skipped?: boolean }> {
  // Concurrency (F19): the read + per-service incident writes run under a Postgres advisory
  // lock, so two overlapping invocations can't both pass a service's open-incident dedup and
  // double-record — the single-flight guarantee is defended in code, not by reserved
  // concurrency = 1 alone.
  let result: { checked: number; incidents: number };
  try {
    result = await withAdvisoryLock(`watchdog:${cfg.env}`, () => check(cfg));
  } catch (err) {
    if (err instanceof ConcurrentRunError) {
      // Another invocation owns the run — skip WITHOUT emitting a heartbeat. The lock-holder
      // emits its own heartbeat on completion, so liveness is still asserted for a benign
      // overlap (the missing-data floor tolerates a few missed intervals). Heartbeating here
      // would mask the dangerous case: chronic overlap where the holder is stuck checking
      // nothing — every run would skip yet report "alive", hiding a watchdog that has stopped
      // actually checking services.
      logger.warn("watchdog skipped: another invocation holds the lock (no heartbeat emitted)", { env: cfg.env });
      return { checked: 0, incidents: 0, skipped: true };
    }
    // Monitoring DB unreachable (read, lock, or incident write): emit the dependency-light
    // metric and rethrow. The watchdog's own heartbeat is withheld on failure, so its absence
    // (the monitorHeartbeat missing-data alarm) is the floor that catches this.
    emitDbUnreachable(cfg.monitorName, cfg.env, { error: err instanceof Error ? err.message : String(err) });
    logger.error("watchdog run failed (monitoring DB unreachable?)", { err });
    throw err;
  }

  // Liveness last — proves the watchdog ran to completion. The missing-data alarm on this
  // heartbeat is the floor: a dead watchdog emits nothing, so its absence is the signal.
  emitMonitorHeartbeat(cfg.monitorName, cfg.env);
  logger.info("watchdog run complete", { checked: result.checked, incidents: result.incidents });
  return result;
}

/** Read service freshness once and evaluate every registered service. Runs under the lock. */
async function check(cfg: WatchdogConfig): Promise<{ checked: number; incidents: number }> {
  // One read of the monitoring DB replaces N probes of N financial databases (F7).
  const heartbeats = await readServiceHeartbeats(
    prisma,
    cfg.env,
    cfg.services.map((s) => s.service),
  );

  // Capture `now` HERE — after acquiring the lock and reading the heartbeats — not at function
  // entry. Otherwise lock-wait + read latency inflate the gap between `now` and the data,
  // biasing every staleness age downward (a just-stale service could read as fresh).
  const now = Date.now();

  let incidents = 0;
  for (const entry of cfg.services) {
    const freshness = heartbeats.get(entry.service) ?? NEVER_REPORTED;
    if (await checkOne(entry, freshness, cfg.env, now, cfg.renotifyAfterSeconds)) incidents++;
  }
  return { checked: cfg.services.length, incidents };
}
