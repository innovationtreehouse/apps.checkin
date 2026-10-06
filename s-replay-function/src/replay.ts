/**
 * Admin operations for the Shopify ingestion pipeline. Both are idempotent and
 * safe to run repeatedly — live writes upsert by (store_id, GID) and the raw log is
 * append-only.
 *
 * - replay()          re-projects raw events from `shopify_raw_event` into the live
 *                     tables. No Shopify calls. Use after a projection-logic fix, or
 *                     to repair live-table divergence. Projection commits ROW-BY-ROW, so a
 *                     replay that fails mid-stream leaves a partial (but valid) projection;
 *                     the FAILED sync_run records how far it got (processed / distinctGids /
 *                     lastCommittedId). Re-running is safe and idempotent (upsert by
 *                     (store_id, GID)) but restarts from the beginning — there
 *                     is no resume.
 * - resetWatermark()  moves `sync_state` (backward or clear) so the NEXT scheduled run
 *                     of s-read-function re-pulls a range from Shopify.
 *
 * Each run is recorded as a `sync_run` row with kind ADMIN for audit.
 */
import {
  type PrismaClient,
  type Prisma,
  ObjectType,
  SyncKind,
  projectNode,
  setWatermark,
  withSyncRun,
  reingestBulkExports,
  logger,
} from "@inventory/s-ingest-core";

/** Object types that carry a sync watermark (refunds ride within orders). */
const WATERMARKED_TYPES: ObjectType[] = [ObjectType.ORDER, ObjectType.PAYOUT, ObjectType.BALANCE_TXN];

export interface ReplayArgs {
  storeId: string;
  objectType?: ObjectType;
  gid?: string;
  /** Only replay events whose occurredAt is at/after this. */
  sinceOccurredAt?: Date;
  /** Who triggered this admin op and why — recorded on the sync_run for audit. */
  actor: string;
  reason: string;
}

export interface ReplayResult extends Record<string, unknown> {
  processed: number;
  distinctGids: number;
}

export async function replay(prisma: PrismaClient, args: ReplayArgs): Promise<ReplayResult> {
  return withSyncRun(prisma, args.storeId, SyncKind.ADMIN, "replay", async () => {
    const where: Prisma.ShopifyRawEventWhereInput = { storeId: args.storeId };
    if (args.objectType) where.objectType = args.objectType;
    if (args.gid) where.shopifyGid = args.gid;
    if (args.sinceOccurredAt) where.occurredAt = { gte: args.sinceOccurredAt };

    const seen = new Set<string>();
    let processed = 0;
    const batchSize = 500;
    let cursorId: bigint | undefined;
    let lastCommittedId: bigint | undefined;

    try {
      // id ASC is NOT newest-first for orders: a bulk snapshot taken before an incremental
      // sync is logged after it. Orders are protected by projectOrder's updatedAt guard;
      // payouts/balance txns are only fetched live, so for them id order is fetch order.

      while (true) {
        const rows = await prisma.shopifyRawEvent.findMany({
          where,
          orderBy: { id: "asc" },
          take: batchSize,
          ...(cursorId !== undefined ? { cursor: { id: cursorId }, skip: 1 } : {}),
          select: { id: true, storeId: true, objectType: true, payload: true, shopifyGid: true },
        });
        if (rows.length === 0) break;
        for (const row of rows) {
          await prisma.$transaction((tx) => projectNode(tx, row.storeId, row.objectType, row.payload));
          processed++;
          seen.add(row.shopifyGid);
          lastCommittedId = row.id;
        }
        cursorId = rows[rows.length - 1].id;
        if (rows.length < batchSize) break;
      }
    } catch (err) {
      // Rows already projected are committed (row-by-row). Attach how far we got so the FAILED
      // sync_run reports real progress instead of nothing (withSyncRun persists partialCounts).
      throw Object.assign(err instanceof Error ? err : new Error(String(err)), {
        partialCounts: {
          processed,
          distinctGids: seen.size,
          lastCommittedId: lastCommittedId?.toString() ?? null,
          failed: true,
        },
      });
    }

    logger.info("replay complete", { ...args, processed, distinctGids: seen.size });
    return { processed, distinctGids: seen.size };
  }, { actor: args.actor, reason: args.reason });
}

export interface ResetWatermarkArgs {
  storeId: string;
  /** Omit to reset all watermarked object types. */
  objectType?: ObjectType;
  /** Target value; null/omit clears it (next sync re-pulls from the cutover date). */
  to?: Date | null;
  /** Who triggered this admin op and why — recorded on the sync_run for audit. */
  actor: string;
  reason: string;
}

export interface ResetWatermarkResult extends Record<string, unknown> {
  objectTypes: string[];
  to: string | null;
}

export async function resetWatermark(prisma: PrismaClient, args: ResetWatermarkArgs): Promise<ResetWatermarkResult> {
  return withSyncRun(prisma, args.storeId, SyncKind.ADMIN, "reset-watermark", async () => {
    const types = args.objectType ? [args.objectType] : WATERMARKED_TYPES;
    const to = args.to ?? null;
    for (const t of types) await setWatermark(prisma, args.storeId, t, to);
    logger.info("reset watermark", { storeId: args.storeId, objectTypes: types, to, actor: args.actor, reason: args.reason });
    return { objectTypes: types as string[], to: to ? to.toISOString() : null };
  }, { actor: args.actor, reason: args.reason });
}

export interface ReingestBulkArgs {
  storeId: string;
  /** Only reprocess exports captured at/after this. */
  sinceFetchedAt?: Date;
  /** Only reprocess exports from this bulk operation. */
  bulkOperationId?: string;
  /** Who triggered this admin op and why — recorded on the sync_run for audit. */
  actor: string;
  reason: string;
}

export interface ReingestBulkResult extends Record<string, unknown> {
  exports: number;
  ingested: number;
}

/**
 * Re-reassemble and re-project the stored verbatim bulk exports — no Shopify calls. Use after
 * a reassembly-logic fix to repair backfilled orders. Idempotent; watermarks untouched.
 */
export async function reingestBulk(prisma: PrismaClient, args: ReingestBulkArgs): Promise<ReingestBulkResult> {
  return withSyncRun(prisma, args.storeId, SyncKind.ADMIN, "reingest-bulk", async () => {
    const result = await reingestBulkExports(prisma, {
      storeId: args.storeId,
      sinceFetchedAt: args.sinceFetchedAt,
      bulkOperationId: args.bulkOperationId,
    });
    logger.info("reingest-bulk complete", { ...args, ...result });
    return result;
  }, { actor: args.actor, reason: args.reason });
}
