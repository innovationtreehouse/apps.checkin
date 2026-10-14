/**
 * Integration test for the advisory-lock concurrency guard (F19). Skipped unless SHOPIFY_READ_DATABASE_URL
 * is set. Two PrismaClients = two DB sessions, the same shape as two Lambda execution
 * environments — the real concurrency hazard the lock defends against.
 */
import { it, expect, beforeAll, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../src/generated/prisma/client.js";
import { withAdvisoryLock, ConcurrentRunError } from "../../src/sync/locks.js";
import { describeDb } from "../helpers/db.js";

function client(max: number): PrismaClient {
  const adapter = new PrismaPg({ connectionString: process.env.SHOPIFY_READ_DATABASE_URL as string, max });
  return new PrismaClient({ adapter });
}

describeDb("withAdvisoryLock", () => {
  // Created in beforeAll (not at suite-collection time) so a skipped run without SHOPIFY_READ_DATABASE_URL
  // never dereferences the missing env var.
  let a: PrismaClient;
  let b: PrismaClient;
  beforeAll(() => {
    a = client(1);
    b = client(1);
  });
  afterAll(async () => {
    await a?.$disconnect();
    await b?.$disconnect();
  });

  it("rejects a second holder while the first holds the lock, then admits it after release", async () => {
    const key = "test-advisory-lock:exclusion";

    await withAdvisoryLock(a, key, async () => {
      // While A holds the lock, a different session (B) must fail fast — not block.
      await expect(withAdvisoryLock(b, key, async () => "ran")).rejects.toBeInstanceOf(ConcurrentRunError);
    });

    // A has released — B can now take it.
    const result = await withAdvisoryLock(b, key, async () => "ran");
    expect(result).toBe("ran");
  });

  it("returns the callback result and releases the lock even when the callback throws", async () => {
    const key = "test-advisory-lock:release-on-throw";

    await expect(
      withAdvisoryLock(a, key, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // The lock was released in `finally`, so it can be re-acquired (here by a different session).
    expect(await withAdvisoryLock(b, key, async () => 42)).toBe(42);
  });

  it("lets different keys run concurrently", async () => {
    await withAdvisoryLock(a, "test-advisory-lock:key-1", async () => {
      // A holds key-1; B taking key-2 is unrelated and must succeed.
      const r = await withAdvisoryLock(b, "test-advisory-lock:key-2", async () => "ok");
      expect(r).toBe("ok");
    });
  });

  it("releases the lock when the holder's pool spans several connections", async () => {
    const key = "test-advisory-lock:pooled";
    const pooled = client(4);
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
