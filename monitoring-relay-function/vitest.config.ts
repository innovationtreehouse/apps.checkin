import { defineConfig } from "vitest/config";
import { resolveJsToTs } from "@checkin/pg-test-harness/vitest-plugin";

export default defineConfig({
  plugins: [resolveJsToTs()],
  test: {
    // Unit suites live beside the source as `src/*.test.ts` (fully mocked, no DB). The
    // DB-gated integration tier lives under `test/integration/` and self-skips unless
    // MONITORING_DATABASE_URL is set (see test/integration/db.ts).
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    environment: "node",
    // The integration tier drains the whole outbox via the shared monitoring-db singleton,
    // so parallel files would see each other's rows. Run files serially; each resets at its
    // own start. The unit suites are tiny, so the serial cost is negligible.
    fileParallelism: false,
    // Boot a throwaway, migration-fresh monitoring Postgres once per run; setupEnv publishes
    // its URL into MONITORING_DATABASE_URL inside the worker. If Docker is absent the harness
    // provides no URL and the integration suites skip.
    globalSetup: ["./test/globalSetup.ts"],
    setupFiles: ["./test/setupEnv.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      // Pure-unit package: thresholds always enforceable (no DB gating). Floors a few
      // points below measured (cli.ts now covered) so a real regression trips without
      // flaking. relay.ts:33 (the advisory-lock release-error callback) is the open branch.
      thresholds: { lines: 95, functions: 90, statements: 95, branches: 78 },
    },
  },
});
