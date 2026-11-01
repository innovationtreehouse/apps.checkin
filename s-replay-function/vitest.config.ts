import { defineConfig } from "vitest/config";
import { resolveJsToTs } from "@checkin/pg-test-harness/vitest-plugin";

export default defineConfig({
  plugins: [resolveJsToTs()],
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Boot a throwaway, migration-fresh Postgres (s-ingest-core's schema) once per run;
    // setupEnv publishes its URL into SHOPIFY_READ_DATABASE_URL inside each worker so the
    // DB-gated integration suites run against it. If Docker is absent the harness provides
    // no URL and those suites skip (their describe/skip gate reads the env var).
    globalSetup: ["./test/globalSetup.ts"],
    setupFiles: ["./test/setupEnv.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts"],
      // cli.ts is now covered (test/unit/cli.test.ts); nothing left to exclude.
      // Most of replay.ts's coverage comes from the SHOPIFY_READ_DATABASE_URL-gated
      // integration tier. Enforce thresholds only when that env is set (CI sets it, and
      // the harness sets it locally when Docker is up) — otherwise a no-DB run would fail
      // purely from skipped tests, not real regressions. Floors a few points below measured
      // with integration on (stmts ~98, branches ~100, funcs ~100, lines ~98).
      thresholds: process.env.SHOPIFY_READ_DATABASE_URL
        ? { lines: 92, functions: 95, statements: 92, branches: 90 }
        : undefined,
    },
  },
});
