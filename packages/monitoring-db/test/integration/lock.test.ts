/**
 * Integration test for the advisory-lock guard against real Postgres. Each withAdvisoryLock call
 * opens its own connection — one DB session, the same shape as one Lambda execution environment —
 * so nested calls exercise the real cross-session hazard the unit tests' fake client cannot.
 * Skipped unless MONITORING_DATABASE_URL is set.
 */
import { it, expect } from "vitest";
import { withAdvisoryLock, ConcurrentRunError } from "../../src/lock.js";
import { runIfDb } from "./db.js";

runIfDb("withAdvisoryLock (integration)", () => {
  it("rejects a second session while the first holds the lock, then admits it after release", async () => {
    const key = "monitoring-test:exclusion";

    await withAdvisoryLock(key, async () => {
      await expect(withAdvisoryLock(key, async () => "ran")).rejects.toBeInstanceOf(ConcurrentRunError);
    });

    expect(await withAdvisoryLock(key, async () => "ran")).toBe("ran");
  });

  it("releases the lock even when the callback throws", async () => {
    const key = "monitoring-test:release-on-throw";
    await expect(
      withAdvisoryLock(key, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(await withAdvisoryLock(key, async () => 42)).toBe(42);
  });

  it("lets different keys run concurrently", async () => {
    await withAdvisoryLock("monitoring-test:key-1", async () => {
      const r = await withAdvisoryLock("monitoring-test:key-2", async () => "ok");
      expect(r).toBe("ok");
    });
  });
});
