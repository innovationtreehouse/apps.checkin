/**
 * Boots an ephemeral, migration-fresh Postgres for this package's DB-backed unit tier (once
 * per `vitest run`). migrateCwd is the package root (where prisma.config.ts + prisma/migrations
 * live). If Docker is absent the harness provides no URL and the DB-gated suites skip (see
 * src/__tests__/helpers/db.ts) — `npm test` stays green without Docker.
 */
import { fileURLToPath } from "node:url";
import { pgGlobalSetup } from "@inventory/pg-test-harness";

export default pgGlobalSetup({
  migrateCwd: fileURLToPath(new URL("..", import.meta.url)),
  envVar: "LOCAL_INVENTORY_DATABASE_URL",
  provideKey: "localInventoryDbUrl",
});
