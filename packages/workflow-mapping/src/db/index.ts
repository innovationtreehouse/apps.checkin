/**
 * PrismaClient for the workflow-mapping database (Postgres via @prisma/adapter-pg), built lazily from
 * WORKFLOW_MAPPING_DATABASE_URL on first use so importing it never connects — `next build` loads route modules
 * with no database. The env-read wiring is guarded by db-client-construction.test.ts.
 * In production WORKFLOW_MAPPING_DATABASE_URL should route through RDS Proxy / pgBouncer
 * (`?pgbouncer=true&connection_limit=1`).
 */
import { PrismaClient } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { createLazyPrisma } from "@checkin/pg-kit";

export const { getPrisma, prisma: db } = createLazyPrisma(
  "WORKFLOW_MAPPING_DATABASE_URL",
  (connectionString) => new PrismaClient({ adapter: new PrismaPg({ connectionString }) }),
  "__wmPrisma",
);

export { isUniqueConstraintError, retryOnUniqueRace } from "@checkin/pg-kit";

export type Db = PrismaClient;
