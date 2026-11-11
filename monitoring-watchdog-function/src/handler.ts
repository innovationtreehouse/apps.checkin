/**
 * Lambda entry point for the monitoring watchdog.
 *
 * Triggered by EventBridge on a cron (every few minutes). Thin: load config, run the
 * watchdog, return a small summary. All real work lives in watchdog.ts so it runs
 * identically from the CLI. Reserved concurrency = 1 is the intended deployment, but the run
 * also takes a Postgres advisory lock, so an accidental overlap skips cleanly.
 */
import { loadWatchdogConfig } from "./registry.js";
import { runWatchdog } from "./watchdog.js";

export async function handler(): Promise<Record<string, unknown>> {
  const cfg = loadWatchdogConfig();
  return runWatchdog(cfg);
}
