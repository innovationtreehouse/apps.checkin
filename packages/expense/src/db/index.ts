/**
 * PrismaClient for the expense database (Postgres via @prisma/adapter-pg), built lazily from
 * EXPENSE_DATABASE_URL on first use so importing it never connects — `next build` loads route modules
 * with no database. The env-read wiring is guarded by db-client-construction.test.ts.
 * In production EXPENSE_DATABASE_URL should route through RDS Proxy / pgBouncer
 * (`?pgbouncer=true&connection_limit=1`).
 */
import { PrismaClient, Prisma } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { createLazyPrisma } from "@checkin/pg-kit";

export const { getPrisma, prisma: db } = createLazyPrisma(
  "EXPENSE_DATABASE_URL",
  (connectionString) => new PrismaClient({ adapter: new PrismaPg({ connectionString }) }),
  "__expensePrisma",
);

export { isUniqueConstraintError } from "@checkin/pg-kit";

/** Client or interactive-transaction client: what repositories and in-tx helpers accept. */
export type Db = PrismaClient | Prisma.TransactionClient;
