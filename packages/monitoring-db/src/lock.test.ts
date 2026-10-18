/**
 * Unit tests for the monitoring wrapper over `@checkin/pg-kit`'s withAdvisoryLock. The lock's
 * own branches are tested in pg-kit; cross-session exclusion against real Postgres lives in
 * test/integration/lock.test.ts.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { ConcurrentRunError as KitConcurrentRunError } from "@checkin/pg-kit";
import { withAdvisoryLock, ConcurrentRunError } from "./lock.js";

const saved = process.env.MONITORING_DATABASE_URL;
afterEach(() => {
  if (saved === undefined) delete process.env.MONITORING_DATABASE_URL;
  else process.env.MONITORING_DATABASE_URL = saved;
});

describe("withAdvisoryLock (monitoring)", () => {
  it("refuses to run without MONITORING_DATABASE_URL, naming it", async () => {
    delete process.env.MONITORING_DATABASE_URL;
    const fn = vi.fn();
    await expect(withAdvisoryLock("k", fn)).rejects.toThrow(/MONITORING_DATABASE_URL/);
    expect(fn).not.toHaveBeenCalled();
  });

  it("re-exports the kit's ConcurrentRunError, so instanceof holds across packages", () => {
    expect(ConcurrentRunError).toBe(KitConcurrentRunError);
  });
});
