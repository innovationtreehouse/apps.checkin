/**
 * @checkin/pg-test-harness — the fleet's template for Postgres integration testing.
 *
 * Every package with a real-Postgres integration tier boots a throwaway, migration-fresh
 * container via this harness instead of assuming a hand-provisioned local/shared Postgres.
 * That kills two fragility classes at once: schema drift (migrations are applied fresh from
 * the package's own committed history every run) and shared-DB contention (each run gets
 * its own database). Disk churn drops too — the container's data dir lives in tmpfs.
 *
 * Onboarding a new Postgres function is ~6 lines of config:
 *   1. `test/globalSetup.ts`  → `export default pgGlobalSetup({ migrateCwd, envVar, provideKey })`
 *   2. `test/setupEnv.ts`     → `applyHarnessEnv({ envVar, provideKey })`
 *   3. `vitest.config.ts`     → `globalSetup: ["./test/globalSetup.ts"], setupFiles: ["./test/setupEnv.ts"]`
 *
 * The runtime client stays env-driven (production reads its domain URL var); that env-read
 * path is guarded against drift by each package's `client.construction.test.ts`, so the
 * integration tier can use explicitly-built clients without leaving the env wiring untested.
 */
export { startPostgres, DEFAULT_PG_IMAGE, type StartedPg } from "./container.js";
export { applyMigrations, type ApplyMigrationsOptions } from "./migrate.js";
export { pgGlobalSetup, type PgHarnessOptions, type GlobalSetupContext } from "./globalSetup.js";
export { applyHarnessEnv, type SetupEnvOptions } from "./setupEnv.js";
export { describeDb, dbGateMode, type DbGateMode } from "./describeDb.js";
