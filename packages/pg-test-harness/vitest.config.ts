import { defineConfig } from "vitest/config";
import { resolveJsToTs } from "./src/vitestPlugin.mjs";

export default defineConfig({
  plugins: [resolveJsToTs()],
  test: {
    // Pure-logic unit suites live beside the source as `src/*.test.ts`. They mock the
    // container/child-process boundary, so no Docker is needed.
    include: ["src/**/*.test.ts"],
    environment: "node",
    // Static provided values for setupEnv.test.ts: `applyHarnessEnv` reads vitest's `inject`,
    // which is fed exactly this way in production (globalSetup `provide`s the URL). Exercising
    // it through the real `inject` channel beats mocking the vitest module itself.
    provide: { pgHarnessProvidedUrl: "postgres://from-harness" },
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts"],
      // container.ts is a thin @testcontainers config wrapper that only runs with Docker — it is
      // exercised live by EVERY package's integration tier (each boots via startPostgres), so a
      // mocked unit here would add nothing. index.ts is a barrel re-export.
      exclude: ["src/**/*.test.ts", "src/container.ts", "src/index.ts"],
      // setupEnv/migrate/globalSetup carry the harness's only real logic (env precedence, CLI
      // resolution, the boot/migrate/provide lifecycle + the no-Docker skip). Floors a few
      // points below measured so a regression in this fleet-wide test gate trips loudly.
      thresholds: { lines: 95, functions: 100, statements: 95, branches: 90 },
    },
  },
});
