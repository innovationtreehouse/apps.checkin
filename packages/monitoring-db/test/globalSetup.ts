/**
 * Boots an ephemeral, migration-fresh Postgres for this package's integration tier.
 * migrateCwd is the package root (where prisma.config.ts + prisma/migrations live).
 */
import { fileURLToPath } from "node:url";
import { pgGlobalSetup } from "@checkin/pg-test-harness";

export default pgGlobalSetup({
  migrateCwd: fileURLToPath(new URL("..", import.meta.url)),
  envVar: "MONITORING_DATABASE_URL",
  provideKey: "monitoringDbUrl",
});
