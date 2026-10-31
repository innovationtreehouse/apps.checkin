/**
 * Lambda entry point for the monitoring relay.
 *
 * Triggered by EventBridge on a schedule (a `rate(...)` expression — see README). Thin: load
 * config, drain the outbox to SNS. All
 * real work lives in relay.ts so it runs identically from the CLI. Reserved concurrency
 * = 1 is the intended deployment, but the drain also takes a Postgres advisory lock,
 * so an accidental overlap skips rather than double-publishing.
 */
import { loadRelayConfig } from "./config.js";
import { runRelay } from "./relay.js";

export async function handler(): Promise<Record<string, unknown>> {
  const cfg = loadRelayConfig();
  return runRelay(cfg);
}
