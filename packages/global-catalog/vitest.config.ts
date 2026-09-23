import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    // Boot a throwaway, migration-fresh Postgres once per run; setupEnv publishes its URL
    // into CATALOG_DATABASE_URL inside the worker so the DB-gated suites (describeDb) run
    // against it. If Docker is absent the harness provides no URL and those suites skip —
    // `npm test` stays green without Docker.
    globalSetup: ["./test/globalSetup.ts"],
    setupFiles: ["./test/setupEnv.ts", "./src/__tests__/setup-node.ts"],
    include: ["src/__tests__/unit/**/*.test.ts"],
    environment: "node",
    pool: "forks",
    // DB-backed unit suites share one catalog DB and clean via resetDb at their own start,
    // so files must not run in parallel against each other.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
