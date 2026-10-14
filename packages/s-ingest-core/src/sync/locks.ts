/**
 * Cross-process mutual exclusion via a Postgres session-scoped advisory lock.
 *
 * F19 defense-in-depth. The ingestion fleet is *intended* to run at Lambda reserved
 * concurrency = 1, but the correctness of raw-log dedup, watermark advance, and the bulk
 * state machine must not REST on that deployment flag alone — a flag is invisible to the
 * code and silently absent if a new service copies the handler shape but forgets the
 * setting. This wraps a unit of work in a Postgres advisory lock so two overlapping
 * invocations for the same key cannot run concurrently: a second caller that can't take
 * the lock fails fast with {@link ConcurrentRunError} instead of corrupting state.
 *
 * A run spans many short transactions over minutes, so the lock is session-scoped and held
 * on a dedicated pg connection: not the Prisma client's pool, where the lock and unlock
 * could land on different connections, and not a transaction left open for the whole run.
 */
import pg from "pg";

/** Thrown when an advisory lock is already held — the caller should treat it as a benign skip. */
export class ConcurrentRunError extends Error {
  constructor(public readonly lockKey: string) {
    super(`advisory lock "${lockKey}" is already held by another run`);
    this.name = "ConcurrentRunError";
  }
}

/**
 * Run `fn` while holding the advisory lock for `key`; throw {@link ConcurrentRunError}
 * immediately if another holder owns it. The lock lives on its own connection, opened for
 * this call and closed in `finally`, which releases it.
 */
export async function withAdvisoryLock<T>(
  key: string,
  fn: () => Promise<T>,
  connectionString: string | undefined = process.env.SHOPIFY_READ_DATABASE_URL,
): Promise<T> {
  if (!connectionString) throw new Error("SHOPIFY_READ_DATABASE_URL is not set; cannot open the advisory-lock connection.");
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
      [key],
    );
    if (rows[0]?.locked !== true) throw new ConcurrentRunError(key);
    return await fn();
  } finally {
    // Ending the session releases the lock; a failed end means the session is already gone.
    await client.end().catch(() => undefined);
  }
}
