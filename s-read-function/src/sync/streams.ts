/**
 * Building blocks shared by the incremental and backfill orchestrators: drain a
 * node stream into the ingest pipeline, then advance the watermark to the newest
 * timestamp seen. The re-read helpers walk a fixed recent window instead and never
 * touch the watermark.
 */
import {
  type PrismaClient,
  EventSource,
  ObjectType,
  type ShopifyConfig,
  ingestNode,
  readSinceIso,
  advanceWatermark,
  logger,
} from "@checkin/s-ingest-core";
import type { ShopifyClient } from "../shopify/client.js";
import { fetchOrders, fetchPayouts, fetchBalanceTransactions } from "../shopify/fetchers.js";

export interface StreamSummary {
  count: number;
  inserted: number;
  maxOccurredAt: Date | null;
}

/** Drain a node generator through ingest, tracking counts and newest timestamp. */
export async function ingestStream(
  prisma: PrismaClient,
  storeId: string,
  objectType: ObjectType,
  source: EventSource,
  gen: AsyncGenerator<unknown>,
  syncRunId?: bigint,
): Promise<StreamSummary> {
  let count = 0;
  let inserted = 0;
  let maxOccurredAt: Date | null = null;
  for await (const node of gen) {
    const res = await ingestNode(prisma, { storeId, objectType, node, source, syncRunId });
    count++;
    if (res.inserted) inserted++;
    if (res.occurredAt && (!maxOccurredAt || res.occurredAt > maxOccurredAt)) maxOccurredAt = res.occurredAt;
  }
  return { count, inserted, maxOccurredAt };
}

/** Orders, scoped to updated_at since the watermark, including cancelled/closed. */
export async function syncOrders(
  prisma: PrismaClient,
  client: ShopifyClient,
  storeId: string,
  cfg: ShopifyConfig,
  source: EventSource,
  syncRunId?: bigint,
): Promise<StreamSummary> {
  const since = await readSinceIso(prisma, storeId, ObjectType.ORDER, cfg.cutoverDate);
  // Datetimes in Shopify search filters MUST be quoted: ':' is the syntax's
  // own separator, so an unquoted ISO value truncates at 'T00' — the payments
  // API rejects it; the orders parser silently tolerates the truncation, which
  // is worse.
  const filter = `updated_at:>='${since}' status:any`;
  logger.info("sync orders", { since, source });
  const summary = await ingestStream(prisma, storeId, ObjectType.ORDER, source, fetchOrders(client, filter), syncRunId);
  await advanceWatermark(prisma, storeId, ObjectType.ORDER, summary.maxOccurredAt);
  return summary;
}

export async function syncPayouts(
  prisma: PrismaClient,
  client: ShopifyClient,
  storeId: string,
  cfg: ShopifyConfig,
  source: EventSource,
  syncRunId?: bigint,
): Promise<StreamSummary> {
  const since = await readSinceIso(prisma, storeId, ObjectType.PAYOUT, cfg.cutoverDate);
  const filter = `issued_at:>='${since}'`;
  logger.info("sync payouts", { since, source });
  const summary = await ingestStream(prisma, storeId, ObjectType.PAYOUT, source, fetchPayouts(client, filter), syncRunId);
  await advanceWatermark(prisma, storeId, ObjectType.PAYOUT, summary.maxOccurredAt);
  return summary;
}

export async function syncBalanceTransactions(
  prisma: PrismaClient,
  client: ShopifyClient,
  storeId: string,
  cfg: ShopifyConfig,
  source: EventSource,
  syncRunId?: bigint,
): Promise<StreamSummary> {
  const since = await readSinceIso(prisma, storeId, ObjectType.BALANCE_TXN, cfg.cutoverDate);
  // `processed_at` (the search field) is the same instant as the node's `transactionDate`,
  // which is what occurredAt/the watermark tracks — filter axis == watermark axis. See
  // BALANCE_TRANSACTIONS_QUERY for the schema verification.
  const filter = `processed_at:>='${since}'`;
  logger.info("sync balance transactions", { since, source });
  const summary = await ingestStream(
    prisma,
    storeId,
    ObjectType.BALANCE_TXN,
    source,
    fetchBalanceTransactions(client, filter),
    syncRunId,
  );
  await advanceWatermark(prisma, storeId, ObjectType.BALANCE_TXN, summary.maxOccurredAt);
  return summary;
}

/** How many days back every incremental run re-reads payouts and balance transactions. */
export const REREAD_WINDOW_DAYS = 30;

export interface RereadSummary {
  count: number;
  changed: number;
  /** True when the re-read reached `stopAt` and left the rest of the window to the next run. */
  stopped: boolean;
}

function rereadSinceIso(now: Date): string {
  return new Date(now.getTime() - REREAD_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Re-ingest already-read nodes so later changes at the store reach the copy. An unchanged
 * node appends no raw event; a changed one is appended and projected like any other read.
 * Callers read the window newest first, so a run that stops at `stopAt` has covered the
 * newest rows, the ones most likely to change. Leaves the watermark alone.
 */
export async function rereadStream(
  prisma: PrismaClient,
  storeId: string,
  objectType: ObjectType,
  gen: AsyncGenerator<unknown>,
  stopAt: Date,
  syncRunId?: bigint,
): Promise<RereadSummary> {
  let count = 0;
  let changed = 0;
  if (Date.now() >= stopAt.getTime()) return { count, changed, stopped: true };
  for await (const node of gen) {
    if (Date.now() >= stopAt.getTime()) return { count, changed, stopped: true };
    const res = await ingestNode(prisma, { storeId, objectType, node, source: EventSource.INCREMENTAL, syncRunId });
    count++;
    if (res.inserted) {
      changed++;
      logger.info("re-read found a change", { objectType, shopifyGid: res.shopifyGid });
    }
  }
  return { count, changed, stopped: false };
}

function logReread(objectType: ObjectType, since: string, summary: RereadSummary): void {
  if (summary.stopped) {
    logger.warn("re-read stopped at its time limit; the next run re-reads the window", { objectType, since, ...summary });
  } else {
    logger.info("re-read done", { objectType, since, ...summary });
  }
}

/** Payouts issued in the last REREAD_WINDOW_DAYS, so a status change after the first read lands. */
export async function rereadPayouts(
  prisma: PrismaClient,
  client: ShopifyClient,
  storeId: string,
  stopAt: Date,
  syncRunId?: bigint,
  now: Date = new Date(),
): Promise<RereadSummary> {
  const since = rereadSinceIso(now);
  const summary = await rereadStream(
    prisma,
    storeId,
    ObjectType.PAYOUT,
    fetchPayouts(client, `issued_at:>='${since}'`, { newestFirst: true }),
    stopAt,
    syncRunId,
  );
  logReread(ObjectType.PAYOUT, since, summary);
  return summary;
}

/** Balance transactions processed in the last REREAD_WINDOW_DAYS, so a later payout assignment lands. */
export async function rereadBalanceTransactions(
  prisma: PrismaClient,
  client: ShopifyClient,
  storeId: string,
  stopAt: Date,
  syncRunId?: bigint,
  now: Date = new Date(),
): Promise<RereadSummary> {
  const since = rereadSinceIso(now);
  const summary = await rereadStream(
    prisma,
    storeId,
    ObjectType.BALANCE_TXN,
    fetchBalanceTransactions(client, `processed_at:>='${since}'`, { newestFirst: true }),
    stopAt,
    syncRunId,
  );
  logReread(ObjectType.BALANCE_TXN, since, summary);
  return summary;
}
