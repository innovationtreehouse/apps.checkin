import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Boot a throwaway, migration-fresh Postgres once per run; setupEnv publishes its URL
    // into EXPENSE_DATABASE_URL inside the worker so the DB-gated suites (describeDb) run
    // against it. If Docker is absent the harness provides no URL and those suites skip —
    // `npm test` stays green without Docker.
    globalSetup: ["./test/globalSetup.ts"],
    setupFiles: ["./test/setupEnv.ts", "./src/__tests__/setup.ts"],
    include: ["src/__tests__/unit/**/*.test.ts", "src/__tests__/integration/**/*.test.ts"],
    environment: "node",
    pool: "forks",
    // DB-backed suites share one expense DB and clean after each test (src/__tests__/setup.ts),
    // so files must not run in parallel against each other.
    fileParallelism: false,
  },
});
