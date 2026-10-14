/**
 * Cross-process mutual exclusion via a Postgres transaction-scoped advisory lock.
 *
 * F19 defense-in-depth. The ingestion fleet is *intended* to run at Lambda reserved
 * concurrency = 1, but the correctness of raw-log dedup, watermark advance, and the bulk
 * state machine must not REST on that deployment flag alone — a flag is invisible to the
 * code and silently absent if a new service copies the handler shape but forgets the
 * setting. This wraps a unit of work in a Postgres advisory lock so two overlapping
 * invocations for the same key cannot run concurrently: a second caller that can't take
 * the lock fails fast with {@link ConcurrentRunError} instead of corrupting state.
 *
 * The lock is `pg_try_advisory_xact_lock`, taken inside an interactive transaction that
 * stays open while `fn` runs and ends when it settles — so acquire and release are bound to
 * that transaction's single connection. A session lock/unlock pair is not safe here: the pg
 * adapter's pool can run the two statements on different connections (the
 * `connection_limit` URL param does not size it), leaving the unlock a no-op and the lock
 * stranded on an idle pooled session. `fn` runs on the client's other pooled connections,
 * so the pool needs at least two. The lock transaction writes nothing; it only holds the key.
 */
import type { PrismaClient } from "../db/client.js";

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
 * immediately if another holder owns it. The lock is released when the holding
 * transaction ends, whether `fn` resolves or throws.
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
