/**
 * Building blocks shared by the incremental and backfill orchestrators: drain a
 * node stream into the ingest pipeline, then advance the watermark to the newest
 * timestamp seen.
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
  // API rejects it (first real-store backfill, 2026-07-14); the orders parser
  // silently tolerates the truncation, which is worse.
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
