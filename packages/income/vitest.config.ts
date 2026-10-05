import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Boot a throwaway, migration-fresh Postgres once per run; setupEnv publishes its URL
    // into INCOME_DATABASE_URL inside the worker so the DB-gated suites (describeDb) run
    // against it. If Docker is absent the harness provides no URL and those suites skip —
    // `npm test` stays green without Docker.
    globalSetup: ["./test/globalSetup.ts"],
    setupFiles: ["./test/setupEnv.ts"],
    include: ["src/__tests__/unit/**/*.test.ts", "src/__tests__/integration/**/*.test.ts"],
    environment: "node",
    pool: "forks",
    // DB-backed suites share one income DB and clean via clearAll at their own start, so
    // files must not run in parallel against each other.
    fileParallelism: false,
  },
});
