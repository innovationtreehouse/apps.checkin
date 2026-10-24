/**
 * Boots an ephemeral, migration-fresh Postgres for s-replay's integration tier.
 *
 * s-replay owns no schema — it operates on the Shopify-read database owned by
 * @checkin/s-ingest-core — so migrateCwd points at that package (its prisma.config.ts +
 * prisma/migrations). The integration suites obtain a client from the core singleton, which
 * setupEnv points at this container via SHOPIFY_READ_DATABASE_URL.
 */
import { fileURLToPath } from "node:url";
import { pgGlobalSetup } from "@checkin/pg-test-harness";

export default pgGlobalSetup({
  migrateCwd: fileURLToPath(new URL("../../packages/s-ingest-core", import.meta.url)),
  envVar: "SHOPIFY_READ_DATABASE_URL",
  provideKey: "shopifyReadDbUrl",
});
