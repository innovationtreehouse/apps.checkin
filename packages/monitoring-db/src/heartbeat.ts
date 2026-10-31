/**
 * Push-based service freshness.
 *
 * Each service writes its own freshness into THIS dedicated monitoring DB (which holds no
 * financial/PII data) via `recordHeartbeat`, and the watchdog reads it back via
 * `readServiceHeartbeats`. The watchdog therefore needs no credential to any service's own
 * database, so it is not a target for every DB credential in the fleet: its blast radius is
 * the monitoring DB alone.
 *
 * Why two timestamps instead of one: the watchdog distinguishes STALE (no recent success)
 * from ERRORING (a failure newer than the last success). Those need the last success and
 * the last failure independently, so we keep
 * them in separate columns and advance each on its own terminal transition.
 */
import type { PrismaClient } from "./generated/prisma/client.js";

/** How a service reports the terminal outcome of one data run. */
export interface HeartbeatBeat {
  /** Pipeline/service name — must match the watchdog registry's `service`. */
  service: string;
  /** Deployment environment — must match the watchdog's env. */
  env: string;
  /** "COMPLETED" advances last_success_at; anything else (FAILED/ABANDONED) advances last_failure_at. */
  status: string;
  /** When the run finished. */
  finishedAt: Date;
  /** Error excerpt for a failure (ignored on success). */
  error?: string | null;
  /** Run kind for diagnostics (e.g. "INCREMENTAL", "BACKFILL"). */
  kind?: string | null;
}

/** Freshness as the watchdog consumes it. */
export interface ServiceFreshness {
  /** Newest COMPLETED data run's finish time, or null if none on record. */
  lastFinishedAt: Date | null;
  /** Newest FAILED/ABANDONED data run, or null if none on record. */
  latestFailure: { failedAt: Date; error: string | null } | null;
}

export const ERROR_EXCERPT_MAX = 1000;

/** The columns one beat writes. Success and failure are mutually exclusive — each beat
 * touches only its own dimension so the other (used for erroring detection) is preserved. */
export interface HeartbeatWriteFields {
  lastSuccessAt?: Date;
  lastFailureAt?: Date;
  lastError?: string | null;
  lastStatus: string;
  lastKind: string | null;
}

/** Pure mapping from a beat to the row fields it writes — the testable core of the upsert. */
export function heartbeatWriteFields(beat: HeartbeatBeat): HeartbeatWriteFields {
  const success = beat.status === "COMPLETED";
  const error = !success && beat.error ? beat.error.slice(0, ERROR_EXCERPT_MAX) : null;
  return {
    ...(success ? { lastSuccessAt: beat.finishedAt } : { lastFailureAt: beat.finishedAt, lastError: error }),
    lastStatus: beat.status,
    lastKind: beat.kind ?? null,
  };
}

/**
 * Upsert a service's freshness row. A success advances only `last_success_at`; a failure
 * advances only `last_failure_at` (+ `last_error`) — the two are independent so "erroring"
 * stays detectable. Ordering is guaranteed by serial execution of a service's runs
 * (reserved concurrency = 1, the same assumption the rest of the pipeline rests on), so a
 * plain upsert is monotonic in practice without an explicit timestamp guard.
 */
export async function recordHeartbeat(prisma: PrismaClient, beat: HeartbeatBeat): Promise<void> {
  const fields = heartbeatWriteFields(beat);
  await prisma.serviceHeartbeat.upsert({
    where: { service_env: { service: beat.service, env: beat.env } },
    create: { service: beat.service, env: beat.env, ...fields },
    update: fields,
  });
}

/**
 * A heartbeat sink bound to one service/env, suitable for injection into run bookkeeping.
 * Returns a function the producer calls with each terminal run outcome. The producer is
 * responsible for calling this best-effort (a monitoring-DB hiccup must never fail a run).
 */
export type HeartbeatSink = (beat: Omit<HeartbeatBeat, "service" | "env">) => Promise<void>;

/** Build a {@link HeartbeatSink} that writes to the monitoring DB for one (service, env). */
export function createHeartbeatSink(prisma: PrismaClient, service: string, env: string): HeartbeatSink {
  return (beat) => recordHeartbeat(prisma, { ...beat, service, env });
}

/**
 * Read freshness for the given services in one query. Returns a map keyed by service name;
 * a service with no row yet is simply absent (the watchdog treats that as "never reported"
 * → stale). Throws only if the monitoring DB itself is unreachable, which the watchdog
 * handles wholesale rather than per service.
 */
export async function readServiceHeartbeats(
  prisma: PrismaClient,
  env: string,
  services: string[],
): Promise<Map<string, ServiceFreshness>> {
  const rows = await prisma.serviceHeartbeat.findMany({
    where: { env, service: { in: services } },
  });
  const map = new Map<string, ServiceFreshness>();
  for (const r of rows) {
    map.set(r.service, {
      lastFinishedAt: r.lastSuccessAt,
      latestFailure: r.lastFailureAt ? { failedAt: r.lastFailureAt, error: r.lastError } : null,
    });
  }
  return map;
}
