/**
 * Integration test for the outbox lifecycle helpers against real Postgres. Proves the
 * oldest-first / PENDING-only claim ordering and the retry semantics (markFailed keeps a
 * row claimable; markSent removes it) that the unit tests can only assert at the query level.
 * Skipped unless MONITORING_DATABASE_URL is set.
 */
import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { claimPending, markSent, markFailed, countDead, requeueDead } from "../../src/outbox.js";
import { OutboxStatus, IncidentKind } from "../../src/generated/prisma/client.js";
import type { PrismaClient } from "../../src/generated/prisma/client.js";
import { runIfDb, singleConnClient, resetTables } from "./db.js";

runIfDb("outbox lifecycle (integration)", () => {
  let prisma: PrismaClient;
  beforeAll(() => {
    prisma = singleConnClient();
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });
  beforeEach(() => resetTables(prisma));

  /** Insert a health_event + outbox row, allowing createdAt/status overrides for ordering tests. */
  async function seed(overrides: Record<string, unknown> = {}) {
    const he = await prisma.healthEvent.create({
      data: { service: "s", env: "prod", kind: IncidentKind.STALE, detail: {} },
    });
    return prisma.outbox.create({
      data: { healthEventId: he.id, service: "s", env: "prod", subject: "x", summary: "y", ...overrides },
    });
  }

  it("returns PENDING rows oldest-first and excludes SENT rows", async () => {
    const older = await seed({ createdAt: new Date("2026-06-01T00:00:00Z") });
    const newer = await seed({ createdAt: new Date("2026-06-02T00:00:00Z") });
    await seed({ status: OutboxStatus.SENT }); // must not be claimed

    const claimed = await claimPending(prisma, 50);
    expect(claimed.map((c) => c.id)).toEqual([older.id, newer.id]);
  });

  it("honors the claim limit", async () => {
    const older = await seed({ createdAt: new Date("2026-06-01T00:00:00Z") });
    await seed({ createdAt: new Date("2026-06-02T00:00:00Z") });

    const claimed = await claimPending(prisma, 1);
    expect(claimed.map((c) => c.id)).toEqual([older.id]);
  });

  it("markSent removes a row from the claimable set", async () => {
    const row = await seed();
    await markSent(prisma, row.id);

    const persisted = await prisma.outbox.findUniqueOrThrow({ where: { id: row.id } });
    expect(persisted.status).toBe(OutboxStatus.SENT);
    expect(persisted.sentAt).toBeInstanceOf(Date);
    expect(await claimPending(prisma, 50)).toHaveLength(0);
  });

  it("markFailed increments attempts, records the error, and leaves the row claimable", async () => {
    const row = await seed();
    await markFailed(prisma, row.id, "boom", { attempts: 0, maxAttempts: 5, permanent: false });

    let persisted = await prisma.outbox.findUniqueOrThrow({ where: { id: row.id } });
    expect(persisted.status).toBe(OutboxStatus.PENDING); // still retryable
    expect(persisted.attempts).toBe(1);
    expect(persisted.lastError).toBe("boom");
    expect(await claimPending(prisma, 50)).toHaveLength(1); // a failed publish is re-claimed

    await markFailed(prisma, row.id, "again", { attempts: 1, maxAttempts: 5, permanent: false });
    persisted = await prisma.outbox.findUniqueOrThrow({ where: { id: row.id } });
    expect(persisted.attempts).toBe(2); // monotonic across attempts
  });

  it("a permanent failure dead-letters the row so it is never re-claimed", async () => {
    const row = await seed();
    await markFailed(prisma, row.id, "AuthorizationError", { attempts: 0, maxAttempts: 5, permanent: true });

    const persisted = await prisma.outbox.findUniqueOrThrow({ where: { id: row.id } });
    expect(persisted.status).toBe(OutboxStatus.DEAD);
    expect(persisted.deadAt).toBeInstanceOf(Date);
    expect(await claimPending(prisma, 50)).toHaveLength(0); // a poison row does not wedge the drain
  });

  it("exhausting the attempt budget dead-letters the row, and countDead/requeueDead recover it", async () => {
    const row = await seed();
    await markFailed(prisma, row.id, "throttled", { attempts: 0, maxAttempts: 2, permanent: false });
    // first failure: attempts 0->1, 1 < 2, still PENDING
    expect((await prisma.outbox.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(OutboxStatus.PENDING);

    await markFailed(prisma, row.id, "throttled", { attempts: 1, maxAttempts: 2, permanent: false });
    // second failure: attempts 1->2, 1+1 >= 2, DEAD
    expect((await prisma.outbox.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(OutboxStatus.DEAD);

    expect(await countDead(prisma, "prod")).toBe(1);
    expect(await claimPending(prisma, 50)).toHaveLength(0);

    const requeued = await requeueDead(prisma, "prod");
    expect(requeued).toBe(1);
    expect(await countDead(prisma, "prod")).toBe(0);
    const back = await prisma.outbox.findUniqueOrThrow({ where: { id: row.id } });
    expect(back.status).toBe(OutboxStatus.PENDING);
    expect(back.attempts).toBe(0); // retry state reset
    expect(back.deadAt).toBeNull();
    expect(await claimPending(prisma, 50)).toHaveLength(1); // claimable again
  });
});
