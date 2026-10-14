/**
 * Cross-process mutual exclusion via a Postgres transaction-scoped advisory lock (F19).
 *
 * The monitoring relay and watchdog are *intended* to run at reserved concurrency = 1, but
 * that flag is invisible to the code. This wraps a unit of work in a Postgres advisory lock
 * so two overlapping invocations cannot drain the outbox / record incidents concurrently: a
 * second caller that can't take the lock fails fast with {@link ConcurrentRunError}.
 *
 * The lock is `pg_try_advisory_xact_lock`, taken inside an interactive transaction that stays
 * open while `fn` runs, so acquire and release are bound to that transaction's one connection.
 * A session lock/unlock pair is not safe under the pg adapter's pool: the two statements can
 * land on different connections, leaving the unlock a no-op and the lock stranded. `fn` runs
 * on the client's other pooled connections, so the pool needs at least two.
 */
import type { PrismaClient } from "./generated/prisma/client.js";

/** Thrown when an advisory lock is already held — the caller should treat it as a benign skip. */
export class ConcurrentRunError extends Error {
  constructor(public readonly lockKey: string) {
    super(`advisory lock "${lockKey}" is already held by another run`);
    this.name = "ConcurrentRunError";
  }
}

/** Longest a locked run may take before the lock transaction is rolled back: the Lambda maximum. */
const LOCK_HOLD_MS = 15 * 60 * 1000;

/**
 * Run `fn` while holding the advisory lock for `key`; throw {@link ConcurrentRunError}
 * immediately if another holder owns it. The lock is released when the holding transaction
 * ends, whether `fn` resolves or throws.
 */
export async function withAdvisoryLock<T>(
  prisma: PrismaClient,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<Array<{ locked: boolean }>>`
        SELECT pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) AS locked`;
      if (rows[0]?.locked !== true) throw new ConcurrentRunError(key);
      return fn();
    },
    { timeout: LOCK_HOLD_MS },
  );
}
