/**
 * Shared scaffolding for the watchdog's DB-gated integration tier.
 *
 * These suites drive runWatchdog against a REAL monitoring Postgres (booted by the harness),
 * with only telemetry mocked — so the real readServiceHeartbeats → evaluate → recordIncident
 * path runs end to end, including the transactional health_event+outbox write and the
 * renotify-window alert dedup that the mocked orchestration test can only simulate.
 *
 * We reuse @checkin/monitoring-db's `prisma` singleton (the client runWatchdog uses) for
 * seeding and assertions, so there is one DB session in play. runWatchdog holds a
 * SESSION-scoped advisory lock across the run; keeping all traffic on the one pooled
 * connection (every query awaited) keeps that lock valid between tests. Cross-session lock
 * exclusion is proven in packages/monitoring-db/test/integration/lock.test.ts and the
 * watchdog's unit skip test, so it is not re-litigated here.
 */
import { describeDb } from "@checkin/pg-test-harness";
import { prisma, recordHeartbeat } from "@checkin/monitoring-db";

export const runIfDb = describeDb("MONITORING_DATABASE_URL");

export { prisma };

/** Truncate all three tables, FK-safe (outbox references health_event). Sequential = one session. */
export async function resetTables(): Promise<void> {
  await prisma.outbox.deleteMany({});
  await prisma.healthEvent.deleteMany({});
  await prisma.serviceHeartbeat.deleteMany({});
}

/** Record a terminal run outcome into the heartbeat table, as a watched service would. */
export async function beat(
  service: string,
  status: "COMPLETED" | "FAILED" | "ABANDONED",
  finishedAt: Date,
  error?: string,
): Promise<void> {
  await recordHeartbeat(prisma, { service, env: "test", status, finishedAt, error });
}
