/**
 * Postgres plumbing shared by every package that owns a database: the lazy Prisma
 * singleton, Prisma error detection, and the session-scoped advisory lock.
 *
 * Each package keeps its own generated Prisma client, so errors are matched by `code`,
 * never by `instanceof` on one client's error classes. The kit imports no database driver,
 * so the library boundary check lets component libraries depend on it. This file has no
 * relative imports: Turbopack resolves only the package's `.` export, and NodeNext
 * consumers need no `.js`.
 */

/**
 * Lazy Prisma singleton for one database. `build` turns a connection string into a client
 * (the caller picks the generated client and driver adapter). Nothing is read or built at
 * import, so `next build` and test harnesses that set the URL later never connect.
 *
 * `getPrisma(url?)` builds on first call from `url`, else `process.env[envVar]`, and
 * memoizes on `globalThis[globalKey]`, so the first caller wins and a warm serverless
 * invocation reuses the pool. `prisma` is a proxy that resolves every property through
 * `getPrisma()`.
 */
export function createLazyPrisma<C extends object>(
  envVar: string,
  build: (connectionString: string) => C,
  globalKey: string,
): { getPrisma: (connectionString?: string) => C; prisma: C } {
  const store = globalThis as Record<string, unknown>;

  function getPrisma(connectionString: string | undefined = process.env[envVar]): C {
    const existing = store[globalKey];
    if (existing) return existing as C;
    if (!connectionString) {
      throw new Error(
        `${envVar} is not set (and no connection string was passed to getPrisma()); ` +
          "the Prisma client cannot be constructed without a database URL.",
      );
    }
    const client = build(connectionString);
    store[globalKey] = client;
    return client;
  }

  const prisma = new Proxy({} as C, {
    get(_target, prop) {
      const client = getPrisma();
      const value = Reflect.get(client, prop);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(client) : value;
    },
  });

  return { getPrisma, prisma };
}

function prismaErrorCode(err: unknown): unknown {
  return typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
}

/** True for a Prisma P2002 unique-constraint violation, from any client. */
export function isUniqueConstraintError(err: unknown): boolean {
  return prismaErrorCode(err) === "P2002";
}

/** True for a Prisma P2025 record-not-found (e.g. an `update` whose `where` no longer matches). */
export function isRecordNotFoundError(err: unknown): boolean {
  return prismaErrorCode(err) === "P2025";
}

/**
 * Run an idempotent upsert that may lose a create race against a concurrent caller. On the
 * unique-constraint loss, retry once: the row now exists, so the retry takes the `update` branch.
 */
export async function retryOnUniqueRace<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    if (isUniqueConstraintError(err)) return op();
    throw err;
  }
}

/** Thrown when an advisory lock is already held — the caller should treat it as a benign skip. */
export class ConcurrentRunError extends Error {
  constructor(public readonly lockKey: string) {
    super(`advisory lock "${lockKey}" is already held by another run`);
    this.name = "ConcurrentRunError";
  }
}

/** The slice of a dedicated Postgres connection the advisory lock needs (a connected `pg.Client` fits). */
export interface AdvisoryLockSession {
  query(sql: string, params: unknown[]): Promise<{ rows: Array<{ locked?: unknown }> }>;
  end(): Promise<void>;
}

/**
 * Run `fn` while holding the Postgres advisory lock for `key`; throw {@link ConcurrentRunError}
 * immediately if another session holds it. A run can span many short transactions, so the
 * lock is session-scoped on a dedicated connection from `openSession`, not the Prisma pool
 * (where lock and unlock could land on different connections). Ending the session in
 * `finally` releases it.
 */
export async function withAdvisoryLock<T>(
  key: string,
  fn: () => Promise<T>,
  openSession: () => Promise<AdvisoryLockSession>,
): Promise<T> {
  const session = await openSession();
  try {
    const { rows } = await session.query("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked", [key]);
    if (rows[0]?.locked !== true) throw new ConcurrentRunError(key);
    return await fn();
  } finally {
    // Ending the session releases the lock; a failed end means the session is already gone.
    await session.end().catch(() => undefined);
  }
}
