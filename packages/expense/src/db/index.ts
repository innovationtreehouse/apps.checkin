/**
 * PrismaClient singleton for the expense database (Postgres via @prisma/adapter-pg).
 *
 * Construction is **lazy**: the URL is read and the client built on first use, not at
 * import. This lets the test harness set EXPENSE_DATABASE_URL after this module loads, and
 * means importing the db never connects or throws merely because a URL is absent —
 * important for `next build`, which loads route modules with no database.
 * The env-read wiring is guarded against drift by db-client-construction.test.ts.
 *
 * Prisma 7 is Rust-free: the client connects through a driver adapter rather than reading
 * `datasource.url` itself. In production EXPENSE_DATABASE_URL should route through RDS Proxy /
 * pgBouncer (`?pgbouncer=true&connection_limit=1`).
 */
import { PrismaClient, Prisma } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const globalForExpense = globalThis as typeof globalThis & { __expensePrisma?: PrismaClient };

/**
 * Get the shared client, constructing it on first call. Pass an explicit `connectionString`
 * to build against a specific database; otherwise EXPENSE_DATABASE_URL is read. Memoized on
 * `globalThis`, so the first caller wins (and a warm serverless invocation reuses the pool).
 */
export function getPrisma(
  connectionString: string | undefined = process.env.EXPENSE_DATABASE_URL,
): PrismaClient {
  if (globalForExpense.__expensePrisma) return globalForExpense.__expensePrisma;
  if (!connectionString) {
    throw new Error(
      "EXPENSE_DATABASE_URL is not set (and no connection string was passed to getPrisma()); " +
        "the Prisma client cannot be constructed without a database URL.",
    );
  }
  const adapter = new PrismaPg({ connectionString });
  const client = new PrismaClient({ adapter });
  globalForExpense.__expensePrisma = client;
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

export function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/** Client or interactive-transaction client: what repositories and in-tx helpers accept. */
export type Db = PrismaClient | Prisma.TransactionClient;
