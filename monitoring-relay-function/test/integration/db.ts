/**
 * Shared scaffolding for the relay's DB-gated integration tier.
 *
 * These suites drive runRelay against a REAL monitoring Postgres (booted by the harness),
 * with only SNS and telemetry mocked — so the actual claim→publish→mark queries and their
 * ordering/persistence are exercised end to end, not just at the query-builder level.
 *
 * We deliberately reuse @inventory/monitoring-db's `prisma` singleton (the same client
 * runRelay uses) for seeding and assertions, so there is exactly one DB session in play.
 * runRelay's drain holds a SESSION-scoped advisory lock across the whole batch; keeping all
 * traffic on the one pooled connection (every query awaited, never Promise.all'd) keeps that
 * lock valid and avoids a lingering lock between tests. Cross-session lock exclusion itself
 * is proven in packages/monitoring-db/test/integration/lock.test.ts and the relay's unit
 * skip test, so it is not re-litigated here.
 */
import { describeDb } from "@inventory/pg-test-harness";
import { prisma, IncidentKind } from "@inventory/monitoring-db";

export const runIfDb = describeDb("MONITORING_DATABASE_URL");

export { prisma };

/** Truncate all three tables, FK-safe (outbox references health_event). Sequential = one session. */
export async function resetTables(): Promise<void> {
  await prisma.outbox.deleteMany({});
  await prisma.healthEvent.deleteMany({});
  await prisma.serviceHeartbeat.deleteMany({});
}

/**
 * Insert a health_event + its PENDING outbox row, the shape recordIncident would produce.
 * Overrides let a test set createdAt (ordering), status, service, etc.
 */
export async function seedAlert(overrides: Record<string, unknown> = {}): Promise<bigint> {
  const { createdAt, status, service = "shopify-read", env = "test", ...rest } = overrides;
  const he = await prisma.healthEvent.create({
    data: { service, env, kind: IncidentKind.STALE, detail: {} },
  });
  const row = await prisma.outbox.create({
    data: {
      healthEventId: he.id,
      service,
      env,
      subject: `[${env}] ${service} sync is stale`,
      summary: "Last successful sync was a while ago.",
      ...(createdAt ? { createdAt } : {}),
      ...(status ? { status } : {}),
      ...rest,
    },
  });
  return row.id;
}
