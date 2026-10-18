/**
 * PrismaClient for the global-catalog database (Postgres via @prisma/adapter-pg), built lazily
 * from CATALOG_DATABASE_URL on first use so importing `@/db` (which every route does) never
 * connects — `next build` loads route modules with no database. The env-read wiring is
 * guarded by db-client-construction.test.ts. In production CATALOG_DATABASE_URL should route
 * through RDS Proxy / pgBouncer (`?pgbouncer=true&connection_limit=1`).
 */
import { PrismaClient } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { createLazyPrisma, retryOnUniqueRace } from "@checkin/pg-kit";

export const { getPrisma, prisma } = createLazyPrisma(
  "CATALOG_DATABASE_URL",
  (connectionString) => new PrismaClient({ adapter: new PrismaPg({ connectionString }) }),
  "__gcPrisma",
);

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

export { isUniqueConstraintError, retryOnUniqueRace } from "@checkin/pg-kit";
