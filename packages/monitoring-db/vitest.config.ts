import { defineConfig } from "vitest/config";
import { resolveJsToTs } from "@checkin/pg-test-harness/vitest-plugin";

export default defineConfig({
  plugins: [resolveJsToTs()],
  test: {
    // Unit tests live beside the source (`src/*.test.ts`); the DB-gated integration tier
    // lives under `test/integration/` and self-skips unless MONITORING_DATABASE_URL is set.
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    environment: "node",
    // The integration tier shares one monitoring DB, and helpers like claimPending query it
    // globally (the relay drains the whole outbox), so per-file scoped cleanup isn't enough —
    // parallel files would see each other's rows. Run files serially; each truncates at its
    // own start via resetTables. The unit suites are tiny, so the serial cost is negligible.
    fileParallelism: false,
    // Boot a throwaway, migration-fresh Postgres once per run; setupEnv publishes its URL
    // into MONITORING_DATABASE_URL inside the worker so the DB-gated suites run against it.
    // If Docker is absent the harness provides no URL and those suites skip (see
    // test/integration/db.ts). The runtime client's env-read path is covered separately by
    // src/db/client.construction.test.ts.
    globalSetup: ["./test/globalSetup.ts"],
    setupFiles: ["./test/setupEnv.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts"],
      // Generated client, barrel, and the connection singleton carry no testable logic.
      exclude: ["src/generated/**", "src/**/*.test.ts", "src/index.ts", "src/db/client.ts"],
      // The MONITORING_DATABASE_URL-gated integration tier rounds out coverage on top of the
      // always-on mocked unit suites. Enforce thresholds only when that env is set (CI sets
      // it; the harness sets it locally when Docker is up) so a no-DB run doesn't fail from
      // skipped tests. Floors below measured with integration on (100% across) leave headroom
      // for the lock/outbox/incident/heartbeat error branches.
      thresholds: process.env.MONITORING_DATABASE_URL
        ? { lines: 95, functions: 95, statements: 95, branches: 90 }
        : undefined,
    },
  },
});
