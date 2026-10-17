/**
 * PrismaClient singleton for the receipt database (Postgres via @prisma/adapter-pg).
 *
 * Construction is **lazy**: the URL is read and the client built on first use, not at
 * import. This lets the test harness set RECEIPT_DATABASE_URL after this module loads, and
 * means importing the db never connects or throws merely because a URL is absent —
 * important for `next build`, which loads route modules with no database.
 * The env-read wiring is guarded against drift by db-client-construction.test.ts.
 *
 * Prisma 7 is Rust-free: the client connects through a driver adapter rather than reading
 * `datasource.url` itself. In production RECEIPT_DATABASE_URL should route through RDS Proxy /
 * pgBouncer (`?pgbouncer=true&connection_limit=1`).
 */
import { PrismaClient } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const globalForReceipt = globalThis as typeof globalThis & { __receiptPrisma?: PrismaClient };

/**
 * Get the shared client, constructing it on first call. Pass an explicit `connectionString`
 * to build against a specific database; otherwise RECEIPT_DATABASE_URL is read. Memoized on
 * `globalThis`, so the first caller wins (and a warm serverless invocation reuses the pool).
 */
export function getPrisma(
  connectionString: string | undefined = process.env.RECEIPT_DATABASE_URL,
): PrismaClient {
  if (globalForReceipt.__receiptPrisma) return globalForReceipt.__receiptPrisma;
  if (!connectionString) {
    throw new Error(
      "RECEIPT_DATABASE_URL is not set (and no connection string was passed to getPrisma()); " +
        "the Prisma client cannot be constructed without a database URL.",
    );
  }
  const adapter = new PrismaPg({ connectionString });
  const client = new PrismaClient({ adapter });
  globalForReceipt.__receiptPrisma = client;
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
