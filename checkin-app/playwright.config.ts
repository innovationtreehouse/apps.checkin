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
  // A retry would run against the seed the first attempt already changed.
  retries: 0,
  forbidOnly: !!process.env.CI,
  // Per test; a spec that walks many pages raises its own from the page count.
  timeout: 180_000,
  // Below the nightly job's limit (e2e-tests.yml) less its setup, so a hung run still ends here,
  // writes its report and keeps its traces.
  globalTimeout: 90 * 60_000,
  expect: { timeout: 30_000 },
  // Steps print as they run, so a run cut short still shows where it was; the nightly
  // workflow lists failed tests from the JSON results.
  reporter: process.env.CI
    ? [["list", { printSteps: true }], ["html", { open: "never" }], ["json", { outputFile: "e2e-results.json" }]]
    : [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: process.env.FLOW_BASE_URL || "http://localhost:4000",
    // A dev server compiles each page on its first visit.
    navigationTimeout: 90_000,
    actionTimeout: 30_000,
    trace: "retain-on-failure",
  },
});
