/**
 * Unit tests for withAdvisoryLock. A fake `$transaction` hands the callback a tx whose
 * `$queryRaw` answers the try-lock, so every branch runs without a database. Cross-session
 * exclusion against real Postgres lives in test/integration/lock.test.ts.
 */
import { describe, it, expect, vi } from "vitest";
import { withAdvisoryLock, ConcurrentRunError } from "./lock.js";
import type { PrismaClient } from "./generated/prisma/client.js";

function prismaWithLock(locked: boolean) {
  const queryRaw = vi.fn().mockResolvedValue([{ locked }]);
  const $transaction = vi.fn((cb: (tx: unknown) => Promise<unknown>) => cb({ $queryRaw: queryRaw }));
  return { prisma: { $transaction } as unknown as PrismaClient, queryRaw, $transaction };
}

describe("withAdvisoryLock", () => {
  it("takes the xact lock inside one transaction and returns fn's result", async () => {
    const { prisma, queryRaw, $transaction } = prismaWithLock(true);
    const fn = vi.fn().mockResolvedValue("ok");

    expect(await withAdvisoryLock(prisma, "k", fn)).toBe("ok");
    expect($transaction).toHaveBeenCalledOnce();
    expect(queryRaw).toHaveBeenCalledOnce();
    expect(String(queryRaw.mock.calls[0][0].join("?"))).toContain("pg_try_advisory_xact_lock");
    expect(fn).toHaveBeenCalledOnce();
  });

  it("throws ConcurrentRunError without running fn when the lock is held", async () => {
    const { prisma } = prismaWithLock(false);
    const fn = vi.fn();

    const run = withAdvisoryLock(prisma, "mykey", fn);

    await expect(run).rejects.toBeInstanceOf(ConcurrentRunError);
    await expect(run).rejects.toMatchObject({ lockKey: "mykey" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("rethrows fn's error (the transaction rollback releases the lock)", async () => {
    const { prisma } = prismaWithLock(true);
    await expect(withAdvisoryLock(prisma, "k", vi.fn().mockRejectedValue(new Error("boom")))).rejects.toThrow("boom");
  });
});
