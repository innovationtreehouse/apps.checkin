/**
 * Cross-process mutual exclusion via a Postgres session-scoped advisory lock (F19).
 *
 * The monitoring relay and watchdog are *intended* to run at reserved concurrency = 1, but
 * that flag is invisible to the code. This wraps a unit of work in a Postgres advisory lock
 * so two overlapping invocations cannot drain the outbox / record incidents concurrently: a
 * second caller that can't take the lock fails fast with {@link ConcurrentRunError}.
 *
 * The lock is held on a dedicated pg connection, not the Prisma client's pool, where the
 * lock and unlock could land on different connections.
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
  connectionString: string | undefined = process.env.MONITORING_DATABASE_URL,
): Promise<T> {
  if (!connectionString) throw new Error("MONITORING_DATABASE_URL is not set; cannot open the advisory-lock connection.");
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
