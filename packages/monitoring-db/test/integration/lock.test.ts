/**
 * Integration test for the advisory-lock guard against real Postgres. Two single-connection
 * clients = two DB sessions, the same shape as two Lambda execution environments — the real
 * concurrency hazard the lock defends against, which the unit tests' fake `$queryRaw` cannot
 * reproduce. Skipped unless MONITORING_DATABASE_URL is set.
 */
import { it, expect, beforeAll, afterAll } from "vitest";
import { withAdvisoryLock, ConcurrentRunError } from "../../src/lock.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../src/generated/prisma/client.js";
import { runIfDb, singleConnClient } from "./db.js";

runIfDb("withAdvisoryLock (integration)", () => {
  let a: PrismaClient;
  let b: PrismaClient;
  beforeAll(() => {
    a = singleConnClient();
    b = singleConnClient();
  });
  afterAll(async () => {
    await a?.$disconnect();
    await b?.$disconnect();
  });

  it("rejects a second session while the first holds the lock, then admits it after release", async () => {
    const key = "monitoring-test:exclusion";

    await withAdvisoryLock(a, key, async () => {
      await expect(withAdvisoryLock(b, key, async () => "ran")).rejects.toBeInstanceOf(ConcurrentRunError);
    });

    expect(await withAdvisoryLock(b, key, async () => "ran")).toBe("ran"); // A released
  });

  it("releases the lock even when the callback throws", async () => {
    const key = "monitoring-test:release-on-throw";
    await expect(
      withAdvisoryLock(a, key, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(await withAdvisoryLock(b, key, async () => 42)).toBe(42);
  });

  it("lets different keys run concurrently", async () => {
    await withAdvisoryLock(a, "monitoring-test:key-1", async () => {
      const r = await withAdvisoryLock(b, "monitoring-test:key-2", async () => "ok");
      expect(r).toBe("ok");
    });
  });

  it("releases the lock when the holder's pool spans several connections", async () => {
    const key = "monitoring-test:pooled";
    const pooled = new PrismaClient({
      adapter: new PrismaPg({ connectionString: process.env.MONITORING_DATABASE_URL as string, max: 4 }),
    });
    try {
      await withAdvisoryLock(pooled, key, async () => {
        // Spread work across the pool so the lock and any release could land on different sessions.
        await Promise.all([1, 2, 3].map(() => pooled.$queryRaw`SELECT pg_sleep(0.05)`));
      });
      expect(await withAdvisoryLock(b, key, async () => "free")).toBe("free");
    } finally {
      await pooled.$disconnect();
    }
  });
});
