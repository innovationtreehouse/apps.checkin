/**
 * Backfill from the cutover date forward, resumable across invocations.
 *
 * Orders use a Bulk Operation (async on Shopify's side): the first call starts it
 * and returns; later calls poll and, once COMPLETED, download + ingest the JSONL.
 * No single invocation blocks on the whole export, so it fits Lambda's timeout.
 *
 * Payouts and balance transactions are not bulk-exportable (they hang off the
 * singleton ShopifyPaymentsAccount), so they are pulled via the paginated cursor
 * fetchers each call, bounded by their own watermark.
 */
import {
  type PrismaClient,
  type ShopifyConfig,
  type HeartbeatSink,
  EventSource,
  ObjectType,
  SyncKind,
  withSyncRun,
  advanceWatermark,
  getBulkState,
  setBulkState,
  ingestBulkOrders,
  logger,
} from "@checkin/s-ingest-core";
import type { ShopifyClient } from "../shopify/client.js";
import { syncPayouts, syncBalanceTransactions } from "./streams.js";
import { startOrdersBackfill, getCurrentBulkOperation, downloadBulkJsonl } from "../shopify/bulk.js";

export interface OrdersBulkStatus {
  action: "STARTED" | "RUNNING" | "INGESTED" | "FAILED" | "NONE";
  status?: string;
  operationId?: string;
  objectCount?: string | null;
  errorCode?: string | null;
  ingested?: number;
  /** JSONL lines skipped because they failed to parse (partial-parse visibility on the sync_run). */
  badLines?: number;
}

export interface BackfillResult extends Record<string, unknown> {
  ordersBulk: OrdersBulkStatus;
  payouts: number;
  balanceTransactions: number;
}

export async function runBackfill(
  prisma: PrismaClient,
  client: ShopifyClient,
  storeId: string,
  cfg: ShopifyConfig,
  heartbeat?: HeartbeatSink,
): Promise<BackfillResult> {
  return withSyncRun(
    prisma,
    storeId,
    SyncKind.BACKFILL,
    "orders(bulk)+payouts+balance_txns",
    async (runId) => {
      const ordersBulk = await stepOrdersBulk(prisma, client, storeId, cfg, runId);
      const payouts = await syncPayouts(prisma, client, storeId, cfg, EventSource.BACKFILL, runId);
      const balance = await syncBalanceTransactions(prisma, client, storeId, cfg, EventSource.BACKFILL, runId);
      return { ordersBulk, payouts: payouts.count, balanceTransactions: balance.count };
    },
    { heartbeat },
  );
}

async function stepOrdersBulk(
  prisma: PrismaClient,
  client: ShopifyClient,
  storeId: string,
  cfg: ShopifyConfig,
  syncRunId?: bigint,
): Promise<OrdersBulkStatus> {
  const cutoverIso = new Date(cfg.cutoverDate).toISOString();
  const state = await getBulkState(prisma, storeId, ObjectType.ORDER);

  // No tracked operation → start one and return immediately.
  if (!state.bulkOperationId) {
    const op = await startOrdersBackfill(client, cutoverIso);
    await setBulkState(prisma, storeId, ObjectType.ORDER, { bulkOperationId: op.id, bulkStatus: op.status });
    logger.info("orders backfill started", { operationId: op.id, status: op.status });
    return { action: "STARTED", operationId: op.id, status: op.status };
  }

  // Tracked operation in flight → poll.
  const op = await getCurrentBulkOperation(client);
  if (!op || op.id !== state.bulkOperationId) {
    // The tracked op is no longer the current one; clear and let a later call restart.
    await setBulkState(prisma, storeId, ObjectType.ORDER, { bulkOperationId: null, bulkStatus: null });
    return { action: "NONE" };
  }

  if (op.status === "COMPLETED") {
    let ingested = 0;
    let badLines = 0;
    if (op.url) {
      // Capture the verbatim JSONL durably, then reassemble + ingest from it (one core path).
      const jsonl = await downloadBulkJsonl(op.url);
      const res = await ingestBulkOrders(prisma, {
        storeId,
        jsonl,
        bulkOperationId: op.id,
        source: EventSource.BACKFILL,
        syncRunId,
      });
      ingested = res.ingested;
      badLines = res.badLineCount;
      await advanceWatermark(prisma, storeId, ObjectType.ORDER, res.maxOccurredAt);
      logger.info("orders backfill captured + ingested", {
        exportId: res.exportId.toString(),
        records: res.recordCount,
        ingested,
        badLines,
      });
    }
    await setBulkState(prisma, storeId, ObjectType.ORDER, { bulkOperationId: null, bulkStatus: "COMPLETED" });
    return { action: "INGESTED", status: "COMPLETED", ingested, badLines };
  }

  if (op.status === "FAILED" || op.status === "CANCELED" || op.status === "EXPIRED") {
    await setBulkState(prisma, storeId, ObjectType.ORDER, { bulkOperationId: null, bulkStatus: op.status });
    return { action: "FAILED", status: op.status, errorCode: op.errorCode ?? null };
  }

  return { action: "RUNNING", status: op.status, objectCount: op.objectCount ?? null };
}
