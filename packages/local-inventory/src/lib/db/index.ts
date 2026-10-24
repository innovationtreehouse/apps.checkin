/**
 * PrismaClient for the local-inventory database (Postgres via @prisma/adapter-pg), built lazily from
 * LOCAL_INVENTORY_DATABASE_URL on first use so importing it never connects — `next build` loads route modules
 * with no database. The env-read wiring is guarded by db-client-construction.test.ts.
 * In production LOCAL_INVENTORY_DATABASE_URL should route through RDS Proxy / pgBouncer
 * (`?pgbouncer=true&connection_limit=1`).
 */
import { PrismaClient } from "../../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { createLazyPrisma } from "@checkin/pg-kit";

export const { getPrisma, prisma: db } = createLazyPrisma(
  "LOCAL_INVENTORY_DATABASE_URL",
  (connectionString) => new PrismaClient({ adapter: new PrismaPg({ connectionString }) }),
  "__localInventoryPrisma",
);

export { isUniqueConstraintError, isRecordNotFoundError } from "@checkin/pg-kit";

export type Db = PrismaClient;
