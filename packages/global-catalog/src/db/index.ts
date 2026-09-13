/**
 * PrismaClient singleton for the global-catalog database (Postgres via @prisma/adapter-pg).
 *
 * Construction is **lazy**: the URL is read and the client built on first use, not at
 * import. This lets the test harness set CATALOG_DATABASE_URL after this module loads,
 * and means importing `@/db` (which every route does) never connects or throws merely because
 * a URL is absent — important for `next build`, which loads route modules with no database.
 * The env-read wiring is guarded against drift by db-client-construction.test.ts.
 *
 * Prisma 7 is Rust-free: the client connects through a driver adapter rather than reading
 * `datasource.url` itself. In production CATALOG_DATABASE_URL should route through RDS
 * Proxy / pgBouncer (`?pgbouncer=true&connection_limit=1`).
 */
import { PrismaClient, Prisma } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

declare global {
  // eslint-disable-next-line no-var
  var __gcPrisma: PrismaClient | undefined;
}

/**
 * Get the shared client, constructing it on first call. Pass an explicit `connectionString`
 * to build against a specific database; otherwise CATALOG_DATABASE_URL is read.
 * Memoized on `globalThis`, so the first caller wins (and a warm serverless invocation reuses
 * the pool).
 */
export function getPrisma(
  connectionString: string | undefined = process.env.CATALOG_DATABASE_URL,
): PrismaClient {
  if (globalThis.__gcPrisma) return globalThis.__gcPrisma;
  if (!connectionString) {
    throw new Error(
      "CATALOG_DATABASE_URL is not set (and no connection string was passed to " +
        "getPrisma()); the Prisma client cannot be constructed without a database URL.",
    );
  }
  const adapter = new PrismaPg({ connectionString });
  const client = new PrismaClient({ adapter });
  globalThis.__gcPrisma = client;
  return client;
}

/**
 * Lazy singleton: every property access resolves through {@link getPrisma}, so the client
 * is built on first real use rather than at import. Existing `prisma.*` / `db.*` call sites
 * are unchanged.
 */
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const client = getPrisma();
    const value = Reflect.get(client as object, prop);
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(client) : value;
  },
});

export const db = prisma;

/**
 * Self-seed the singleton provisional_part_sequence row (id=1), idempotently. The schema
 * itself is applied out-of-band — by the test harness (`prisma migrate deploy` into a
 * throwaway Postgres) and by migrations in production — so this no longer shells out to
 * `prisma migrate deploy`. It is a no-op when no database URL is configured, so a Docker-less
 * test run (where the DB-gated suites skip) doesn't connect.
 */
export async function initDb(): Promise<void> {
  if (!process.env.CATALOG_DATABASE_URL) return;
  // upsert is SELECT-then-INSERT; multiple server replicas running register() at cold start can
  // both miss the row and race the create. retryOnUniqueRace keeps the seed idempotent.
  await retryOnUniqueRace(() =>
    prisma.provisionalPartSequence.upsert({
      where: { id: 1 },
      create: { id: 1 },
      update: {},
    }),
  );
  // Postgres SERIAL sequences are NOT advanced by an explicit-id insert (unlike SQLite
  // AUTOINCREMENT, which bumps its counter on `INSERT ... (id) VALUES (1)`). Allocation works
  // by inserting a bare row to claim the next id (see db/sequence.ts), so without this the
  // first allocation's nextval would return 1 and collide with the seeded row. Align the
  // sequence to MAX(id) so the next allocation lands at 2, matching the old SQLite behavior.
  await prisma.$executeRawUnsafe(
    `SELECT setval(pg_get_serial_sequence('provisional_part_sequence', 'id'), (SELECT COALESCE(MAX(id), 1) FROM provisional_part_sequence))`,
  );
}

export function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/**
 * Run an idempotent upsert that may lose a create race against a concurrent caller (another
 * server replica or warm Lambda). On the unique-constraint loss, retry once: the row now exists,
 * so the retry takes the `update` branch and the write is preserved. The database is the arbiter,
 * so this is correct across processes — an in-memory guard is not.
 */
export async function retryOnUniqueRace<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    if (isUniqueConstraintError(err)) return op();
    throw err;
  }
}
