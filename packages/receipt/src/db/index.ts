/**
 * PrismaClient for the receipt database (Postgres via @prisma/adapter-pg), built lazily from
 * RECEIPT_DATABASE_URL on first use so importing it never connects — `next build` loads route modules
 * with no database. The env-read wiring is guarded by db-client-construction.test.ts.
 * In production RECEIPT_DATABASE_URL should route through RDS Proxy / pgBouncer
 * (`?pgbouncer=true&connection_limit=1`).
 */
import { PrismaClient } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { createLazyPrisma } from "@checkin/pg-kit";

export const { getPrisma, prisma: db } = createLazyPrisma(
  "RECEIPT_DATABASE_URL",
  (connectionString) => new PrismaClient({ adapter: new PrismaPg({ connectionString }) }),
  "__receiptPrisma",
);

export type Db = PrismaClient;
