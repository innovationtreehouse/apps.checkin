import { defineConfig } from "vitest/config";
import { resolveJsToTs } from "@checkin/pg-test-harness/vitest-plugin";

export default defineConfig({
  plugins: [resolveJsToTs()],
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Boot a throwaway, migration-fresh Postgres once per run; setupEnv publishes its URL
    // into SHOPIFY_READ_DATABASE_URL inside each worker so the DB-gated suites run against
    // it. If Docker is absent the harness provides no URL and those suites skip (see
    // test/helpers/db.ts). The runtime client's env-read path is covered separately by
    // test/unit/client.construction.test.ts.
    globalSetup: ["./test/globalSetup.ts"],
    setupFiles: ["./test/setupEnv.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      // Measure the hand-written source only. The generated Prisma client, the barrel
      // re-export, and the connection singleton (pure plumbing;
      // its env-read wiring is covered by test/unit/client.construction.test.ts) carry no
      // logic worth a threshold.
      include: ["src/**/*.ts"],
      exclude: ["src/generated/**", "src/index.ts", "src/db/client.ts"],
      // Thresholds are only meaningful when the SHOPIFY_READ_DATABASE_URL-gated integration suites
      // actually run — otherwise a no-DB run would fail purely from skipped tests, not
      // from real regressions. CI sets SHOPIFY_READ_DATABASE_URL, so the floor is enforced there.
      // Floors set a few points below current coverage (lines ~98, funcs ~98, stmts ~96,
      // branches ~82) so a real regression trips them without flaking on minor shifts.
      thresholds: process.env.SHOPIFY_READ_DATABASE_URL
        ? { lines: 92, functions: 95, statements: 92, branches: 78 }
        : undefined,
    },
  },
});
