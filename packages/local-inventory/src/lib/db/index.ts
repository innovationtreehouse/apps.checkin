/**
 * PrismaClient singleton for the local-inventory database (Postgres via @prisma/adapter-pg).
 *
 * Construction is **lazy**: the URL is read and the client built on first use, not at
 * import. This lets the test harness set LOCAL_INVENTORY_DATABASE_URL after this module
 * loads, and means importing the db never connects or throws merely because a URL is absent.
 * The env-read wiring is guarded against drift by db-client-construction.test.ts.
 *
 * Prisma 7 is Rust-free: the client connects through a driver adapter rather than reading
 * `datasource.url` itself. In production LOCAL_INVENTORY_DATABASE_URL should route through
 * RDS Proxy / pgBouncer (`?pgbouncer=true&connection_limit=1`).
 */
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

declare global {
  // eslint-disable-next-line no-var
  var __localInventoryPrisma: PrismaClient | undefined;
}

/**
 * Get the shared client, constructing it on first call. Pass an explicit `connectionString`
 * to build against a specific database; otherwise LOCAL_INVENTORY_DATABASE_URL is read.
 * Memoized on `globalThis`, so the first caller wins (and a warm serverless invocation reuses
 * the pool).
 */
export function getPrisma(
  connectionString: string | undefined = process.env.LOCAL_INVENTORY_DATABASE_URL,
): PrismaClient {
  if (globalThis.__localInventoryPrisma) return globalThis.__localInventoryPrisma;
  if (!connectionString) {
    throw new Error(
      "LOCAL_INVENTORY_DATABASE_URL is not set (and no connection string was passed to " +
        "getPrisma()); the Prisma client cannot be constructed without a database URL.",
    );
  }
  const adapter = new PrismaPg({ connectionString });
  const client = new PrismaClient({ adapter });
  globalThis.__localInventoryPrisma = client;
  return client;
}

/**
 * Lazy singleton: every property access resolves through {@link getPrisma}, so the client
 * is built on first real use rather than at import. Existing `db.*` call sites are unchanged.
 */
export const db: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const client = getPrisma();
    const value = Reflect.get(client as object, prop);
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(client) : value;
  },
});

export type Db = PrismaClient;

/** True for a Prisma P2002 unique-constraint violation, duck-typed so it holds for any client. */
export function isUniqueConstraintError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002";
}

/**
 * Run an idempotent upsert that may lose a create race against a concurrent caller (another
 * module instance, server replica, or warm Lambda). On the unique-constraint loss, retry once:
 * the row now exists, so the retry takes the `update` branch and the write is preserved. The
 * database is the arbiter, so this is correct across processes — an in-memory guard is not.
 */
export async function retryOnUniqueRace<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    if (isUniqueConstraintError(err)) return op();
    throw err;
  }
}

// Cached promise so concurrent callers (e.g. container import + beforeAll) all wait for the same init.
let _initPromise: Promise<void> | null = null;

/**
 * Ensure the singleton settings_data row (id=1) exists, idempotently and memoized. The schema
 * itself is applied out-of-band — by the test harness (`prisma migrate deploy` into a
 * throwaway Postgres) and by migrations in production — so this no longer replays migration
 * SQL into an in-memory SQLite DB; it only self-seeds the singleton row.
 */
export function initDb(): Promise<void> {
  if (!_initPromise) _initPromise = _doInitDb();
  return _initPromise;
}

async function _doInitDb(): Promise<void> {
  // Prisma's upsert is SELECT-then-INSERT, so concurrent seeders (Next.js instantiates this
  // module in several bundle contexts — each with its own _initPromise — plus the poller) can
  // both miss the row and both INSERT id=1, the loser throwing P2002. retryOnUniqueRace makes
  // the seed idempotent under any concurrency.
  await retryOnUniqueRace(() =>
    db.settingsData.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} }),
  );
}

/** Reset init state — only call from tests after wiping the DB. */
export function resetInitState(): void {
  _initPromise = null;
}
