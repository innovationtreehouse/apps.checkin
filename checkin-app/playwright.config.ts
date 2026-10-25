import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests (e2e/*.e2e.ts) against a RUNNING seeded dev server, the one flow tests use;
 * nothing here starts a server. See AGENTS.md → Test classes.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  // A library's nav module exports only an `import` condition; e2e/tsconfig.json maps it to source.
  tsconfig: "./e2e/tsconfig.json",
  // Specs mutate the shared seed, so they run one at a time.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: !!process.env.CI,
  // The first spec pays the dev server's compile of every page and route it opens.
  timeout: 600_000,
  expect: { timeout: 30_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: process.env.FLOW_BASE_URL || "http://localhost:4000",
    navigationTimeout: 120_000,
    trace: "retain-on-failure",
  },
});
