/**
 * PrismaClient singleton for the bulkdonation database (Postgres via @prisma/adapter-pg).
 *
 * Construction is **lazy**: the URL is read and the client built on first use, not at
 * import. This lets the test harness set BULK_DONATION_DATABASE_URL after this module loads,
 * and means importing the db never connects or throws merely
 * because a URL is absent — important for `next build`, which loads route modules with no
 * database. The env-read wiring is guarded against drift by db-client-construction.test.ts.
 *
 * Prisma 7 is Rust-free: the client connects through a driver adapter rather than reading
 * `datasource.url` itself. In production BULK_DONATION_DATABASE_URL should route through RDS
 * Proxy / pgBouncer (`?pgbouncer=true&connection_limit=1`).
 */
import { PrismaClient } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const globalForBulkDonation = globalThis as typeof globalThis & { __bulkDonationPrisma?: PrismaClient };

/**
 * Get the shared client, constructing it on first call. Pass an explicit `connectionString`
 * to build against a specific database; otherwise BULK_DONATION_DATABASE_URL is read. Memoized
 * on `globalThis`, so the first caller wins (and a warm serverless invocation reuses the pool).
 */
export function getPrisma(
  connectionString: string | undefined = process.env.BULK_DONATION_DATABASE_URL,
): PrismaClient {
  if (globalForBulkDonation.__bulkDonationPrisma) return globalForBulkDonation.__bulkDonationPrisma;
  if (!connectionString) {
    throw new Error(
      "BULK_DONATION_DATABASE_URL is not set (and no connection string was passed to " +
        "getPrisma()); the Prisma client cannot be constructed without a database URL.",
    );
  }
  const adapter = new PrismaPg({ connectionString });
  const client = new PrismaClient({ adapter });
  globalForBulkDonation.__bulkDonationPrisma = client;
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

export type PrismaTransactionClient = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

export type DbOrTx = PrismaClient | PrismaTransactionClient;

export function isUniqueConstraintError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002";
}

