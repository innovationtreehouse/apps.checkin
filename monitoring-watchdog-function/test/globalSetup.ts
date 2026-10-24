/**
 * Boots an ephemeral, migration-fresh monitoring Postgres for this function's integration
 * tier. The watchdog owns no schema of its own — it reads @checkin/monitoring-db's
 * heartbeats and writes its incidents — so migrateCwd points at the schema-owning package
 * (monitoring-db), exactly as s-replay points at s-ingest-core.
 */
import { fileURLToPath } from "node:url";
import { pgGlobalSetup } from "@checkin/pg-test-harness";

export default pgGlobalSetup({
  migrateCwd: fileURLToPath(new URL("../../packages/monitoring-db", import.meta.url)),
  envVar: "MONITORING_DATABASE_URL",
  provideKey: "monitoringDbUrl",
});
