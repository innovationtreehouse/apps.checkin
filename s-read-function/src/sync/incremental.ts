/**
 * Incremental sync: pull orders, payouts, and balance transactions changed since
 * the last watermark, in one run. Idempotent — overlapping windows and re-reads
 * collapse on GID upsert. Order status changes (cancellations, refunds) are
 * captured because `status:any` returns closed/cancelled orders.
 *
 * Payouts and balance transactions are filtered by issue/processing time, which a
 * later status change or payout assignment does not move, so each run also re-reads
 * the last REREAD_WINDOW_DAYS of both after the forward pull.
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
import { syncDeadlineMinutes } from "../deadline.js";
import {
  syncOrders,
  syncPayouts,
  syncBalanceTransactions,
  rereadPayouts,
  rereadBalanceTransactions,
} from "./streams.js";

export interface IncrementalResult extends Record<string, unknown> {
  orders: number;
  payouts: number;
  balanceTransactions: number;
  payoutsReread: number;
  balanceTransactionsReread: number;
  rereadStopped: boolean;
}

/** The re-read stops once the run has used this share of its deadline, leaving the rest as headroom. */
const REREAD_SHARE_OF_DEADLINE = 0.5;

export async function runIncremental(
  prisma: PrismaClient,
  client: ShopifyClient,
  storeId: string,
  cfg: ShopifyConfig,
  heartbeat?: HeartbeatSink,
): Promise<IncrementalResult> {
  const rereadStopAt = new Date(Date.now() + syncDeadlineMinutes() * 60 * 1000 * REREAD_SHARE_OF_DEADLINE);
  return withSyncRun(
    prisma,
    storeId,
    SyncKind.INCREMENTAL,
    "orders+payouts+balance_txns",
    async (runId) => {
      const orders = await syncOrders(prisma, client, storeId, cfg, EventSource.INCREMENTAL, runId);
      const payouts = await syncPayouts(prisma, client, storeId, cfg, EventSource.INCREMENTAL, runId);
      const balance = await syncBalanceTransactions(prisma, client, storeId, cfg, EventSource.INCREMENTAL, runId);
      const payoutsReread = await rereadPayouts(prisma, client, storeId, rereadStopAt, runId);
      const balanceReread = await rereadBalanceTransactions(prisma, client, storeId, rereadStopAt, runId);
      return {
        orders: orders.count,
        payouts: payouts.count,
        balanceTransactions: balance.count,
        payoutsReread: payoutsReread.count,
        balanceTransactionsReread: balanceReread.count,
        rereadStopped: payoutsReread.stopped || balanceReread.stopped,
      };
    },
    { heartbeat },
  );
}
