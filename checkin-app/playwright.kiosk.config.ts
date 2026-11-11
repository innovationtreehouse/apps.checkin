import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

/** The kiosk browser tier (kiosk-flow/*.kiosk-e2e.ts). Run by `deploy/kiosk-flow.sh e2e`, which provides the kiosk image. */
export default defineConfig({
  ...base,
  testDir: "./kiosk-flow",
  testMatch: "**/*.kiosk-e2e.ts",
  globalTimeout: 20 * 60_000,
});
