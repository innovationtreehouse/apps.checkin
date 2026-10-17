/**
 * Incremental sync: pull orders, payouts, and balance transactions changed since
 * the last watermark, in one run. Idempotent — overlapping windows and re-reads
 * collapse on GID upsert. Order status changes (cancellations, refunds) are
 * captured because `status:any` returns closed/cancelled orders.
 */
import {
  type PrismaClient,
  type ShopifyConfig,
  type HeartbeatSink,
  EventSource,
  SyncKind,
  withSyncRun,
} from "@checkin/s-ingest-core";
import type { ShopifyClient } from "../shopify/client.js";
import { syncOrders, syncPayouts, syncBalanceTransactions } from "./streams.js";

export interface IncrementalResult extends Record<string, unknown> {
  orders: number;
  payouts: number;
  balanceTransactions: number;
}

export async function runIncremental(
  prisma: PrismaClient,
  client: ShopifyClient,
  storeId: string,
  cfg: ShopifyConfig,
  heartbeat?: HeartbeatSink,
): Promise<IncrementalResult> {
  return withSyncRun(
    prisma,
    storeId,
    SyncKind.INCREMENTAL,
    "orders+payouts+balance_txns",
    async (runId) => {
      const orders = await syncOrders(prisma, client, storeId, cfg, EventSource.INCREMENTAL, runId);
      const payouts = await syncPayouts(prisma, client, storeId, cfg, EventSource.INCREMENTAL, runId);
      const balance = await syncBalanceTransactions(prisma, client, storeId, cfg, EventSource.INCREMENTAL, runId);
      return {
        orders: orders.count,
        payouts: payouts.count,
        balanceTransactions: balance.count,
      };
    },
    { heartbeat },
  );
}
