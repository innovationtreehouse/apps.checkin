/**
 * Integration test for the advisory-lock concurrency guard. Skipped unless SHOPIFY_READ_DATABASE_URL
 * is set. Each withAdvisoryLock call opens its own connection — one DB session, the same shape as
 * one Lambda execution environment — so nested calls exercise the real cross-session hazard.
 */
import { it, expect } from "vitest";
import { withAdvisoryLock, ConcurrentRunError } from "../../src/sync/locks.js";
import { describeDb } from "../helpers/db.js";

describeDb("withAdvisoryLock", () => {
  it("rejects a second holder while the first holds the lock, then admits it after release", async () => {
    const key = "test-advisory-lock:exclusion";

    await withAdvisoryLock(key, async () => {
      // While the first session holds the lock, a second must fail fast — not block.
      await expect(withAdvisoryLock(key, async () => "ran")).rejects.toBeInstanceOf(ConcurrentRunError);
    });

    // The first session has closed — the lock is free again.
    expect(await withAdvisoryLock(key, async () => "ran")).toBe("ran");
  });

  it("returns the callback result and releases the lock even when the callback throws", async () => {
    const key = "test-advisory-lock:release-on-throw";

    await expect(
      withAdvisoryLock(key, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(await withAdvisoryLock(key, async () => 42)).toBe(42);
  });

  it("lets different keys run concurrently", async () => {
    await withAdvisoryLock("test-advisory-lock:key-1", async () => {
      const r = await withAdvisoryLock("test-advisory-lock:key-2", async () => "ok");
      expect(r).toBe("ok");
    });
  });
});
