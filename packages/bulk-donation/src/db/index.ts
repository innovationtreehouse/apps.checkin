/**
 * PrismaClient for the bulk-donation database (Postgres via @prisma/adapter-pg), built lazily from
 * BULK_DONATION_DATABASE_URL on first use so importing it never connects — `next build` loads route modules
 * with no database. The env-read wiring is guarded by db-client-construction.test.ts.
 * In production BULK_DONATION_DATABASE_URL should route through RDS Proxy / pgBouncer
 * (`?pgbouncer=true&connection_limit=1`).
 */
import { PrismaClient } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { createLazyPrisma } from "@checkin/pg-kit";

export const { getPrisma, prisma: db } = createLazyPrisma(
  "BULK_DONATION_DATABASE_URL",
  (connectionString) => new PrismaClient({ adapter: new PrismaPg({ connectionString }) }),
  "__bulkDonationPrisma",
);

export { isUniqueConstraintError } from "@checkin/pg-kit";

export type PrismaTransactionClient = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

export type DbOrTx = PrismaClient | PrismaTransactionClient;
