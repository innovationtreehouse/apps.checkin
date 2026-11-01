import { defineConfig } from "vitest/config";
import { resolveJsToTs } from "@checkin/pg-test-harness/vitest-plugin";

export default defineConfig({
  plugins: [resolveJsToTs()],
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts"],
      // queries.ts is pure GraphQL query/mutation strings with no logic; it's exercised
      // indirectly by the fakeClient-driven suites, so it carries no threshold worth gating.
      exclude: ["src/shopify/queries.ts"],
      // Suites are fully mocked (fakeClient + fakePrisma), so thresholds are always
      // enforceable — no DB gating needed. cli.ts is now covered. Floors a few points below
      // measured so a real regression trips without flaking on minor shifts.
      thresholds: { lines: 96, functions: 97, statements: 96, branches: 90 },
    },
  },
});
