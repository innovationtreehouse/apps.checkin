/**
 * DB-gate for the integration tier. `describeDb` is `describe` when BULK_DONATION_DATABASE_URL
 * is set (the harness publishes the container URL in test/setupEnv.ts) and `describe.skip`
 * otherwise — so suites that need a real Postgres run against the throwaway container when
 * Docker is up, and cleanly skip (not fail) on a machine without Docker.
 */
import { describe } from "vitest";

export const describeDb = process.env.BULK_DONATION_DATABASE_URL ? describe : describe.skip;
