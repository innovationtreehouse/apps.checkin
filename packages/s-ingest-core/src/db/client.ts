/**
 * PrismaClient singleton for the Shopify mirror database, built lazily from SHOPIFY_READ_DATABASE_URL on first
 * use so importing the package never connects or throws merely because a URL is absent.
 * Module scope means a warm Lambda invocation reuses the client and its connection. In
 * production SHOPIFY_READ_DATABASE_URL should route through RDS Proxy / pgBouncer with
 * `?pgbouncer=true&connection_limit=1`; pool timeouts and TLS checks are governed by its
 * params (Prisma 7's pg adapter uses pg's defaults). The env-read wiring is guarded by
 * `test/unit/client.construction.test.ts`.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { createLazyPrisma } from "@checkin/pg-kit";
import { PrismaClient } from "../generated/prisma/client.js";

export const { getPrisma, prisma } = createLazyPrisma(
  "SHOPIFY_READ_DATABASE_URL",
  (connectionString) => new PrismaClient({ adapter: new PrismaPg({ connectionString }) }),
  "__shopifyReadPrisma",
);

export type { PrismaClient };
