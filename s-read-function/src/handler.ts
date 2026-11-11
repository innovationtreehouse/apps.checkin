/**
 * Lambda entry point. Thin: load config, build the client, route the event to an
 * orchestrator. All real work lives in sync/* so it runs identically from the CLI.
 *
 * Triggered by EventBridge. The event selects the mode:
 *   { "mode": "incremental" }  (default) — delta pull since the watermark
 *   { "mode": "backfill" }                — Bulk Operation backfill / poll step
 */
import { z } from "zod";
import { prisma, loadDbConfig, loadShopifyConfig, reapStaleRuns, logger, ConcurrentRunError } from "@checkin/s-ingest-core";
import { createShopifyClient } from "./shopify/client.js";
import { ensureStore } from "./sync/store.js";
import { runIncremental } from "./sync/incremental.js";
import { runBackfill } from "./sync/backfill.js";
import { buildHeartbeatSink } from "./monitoring.js";

/**
 * The EventBridge invocation contract. Validated with Zod at the boundary — the Lambda
 * event is an external input — and defaulted to an incremental pull when absent/empty.
 */
export const SyncEventSchema = z
  .object({ mode: z.enum(["incremental", "backfill"]).default("incremental") })
  .strict();

export type SyncEvent = z.input<typeof SyncEventSchema>;

/**
 * Hard ceiling on a sync run's lifetime (the "limited duration" half of the
 * infra contract: trigger Lambda → one-off ECS task). ECS RunTask has no native
 * max-duration, so a wedged run would otherwise bill until someone notices.
 * The timer is unref'd: a completed run lets the process exit naturally before
 * it fires; a hung run gets force-failed, and the next tick's reapStaleRuns
 * relabels the interrupted row. Override with SYNC_DEADLINE_MINUTES (backfill
 * ingest steps on very large stores may need more than the default 55m).
 */
export function armSyncDeadline(mode: string): void {
  const minutes = Math.max(1, Number(process.env.SYNC_DEADLINE_MINUTES) || 55);
  const timer = setTimeout(() => {
    logger.error("sync deadline exceeded — exiting so the task cannot run unbounded", { mode, minutes });
    process.exit(1);
  }, minutes * 60 * 1000);
  timer.unref();
}

export async function handler(event: unknown = {}): Promise<Record<string, unknown>> {
  const { mode } = SyncEventSchema.parse(event ?? {});
  const dbCfg = loadDbConfig();
  const shopifyCfg = loadShopifyConfig();
  const client = createShopifyClient(shopifyCfg);

  // Push run freshness to the monitoring DB so the watchdog reads it there, instead of
  // reaching into this service's own database. No-op when monitoring isn't configured.
  const heartbeat = buildHeartbeatSink();

  // Relabel any run left RUNNING by a previously-killed process, so a dead run never
  // looks in-flight, and tell the watchdog it died. The watermark already reflects what
  // truly completed.
  await reapStaleRuns(prisma, heartbeat);

  // The store_id stamped on rows is resolved from the live store (its permanent
  // myshopifyDomain) and recorded in the `store` registry — not trusted from config.
  const { storeId } = await ensureStore(prisma, client, dbCfg.storeId);

  // If another invocation already holds this store's run lock (reserved-concurrency = 1 was
  // bypassed, or a previous run is still in flight), skip cleanly rather than running a second
  // concurrent sync — the next scheduled tick proceeds normally.
  try {
    if (mode === "backfill") {
      return await runBackfill(prisma, client, storeId, shopifyCfg, heartbeat);
    }
    return await runIncremental(prisma, client, storeId, shopifyCfg, heartbeat);
  } catch (err) {
    if (err instanceof ConcurrentRunError) {
      logger.warn("sync skipped: another run is already in progress for this store", { storeId, mode });
      return { skipped: true, mode, reason: "another sync run is already in progress for this store" };
    }
    throw err;
  }
}
