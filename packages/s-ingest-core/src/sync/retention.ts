/**
 * Retention for the reader's copies of buyers' data. A raw log entry is a financial record, kept
 * seven years past its fiscal year's Form 990 deadline, dated by its store event. A bulk export is a
 * bulk copy, kept 90 days after the run that captured it ended, whether or not that run loaded it.
 * Each run is capped and recorded as an ADMIN sync_run carrying its counts.
 */
import { form990DueBefore } from "@checkin/utils";
import { logger } from "@checkin/telemetry";
import type { PrismaClient } from "../db/client.js";
import { SyncKind } from "../generated/prisma/client.js";
import { withSyncRun } from "./run.js";

export const RAW_EVENT_KEEP_YEARS = 7;
export const EXPORT_KEEP_MS = 90 * 24 * 60 * 60 * 1000;
export const RAW_EVENT_CAP = 1000;
export const EXPORT_CAP = 50;
export const RETENTION_ACTOR = "s-read:retention";
/** The sync_run scope of a retention pass; checkin-app/src/lib/shopifyRead/client.ts skips it as not a sync. */
export const RETENTION_SCOPE = "retention";

export interface SweepResult {
  deleted: number;
  failed: number;
}

export interface RetentionResult extends Record<string, unknown> {
  rawEvents: number;
  exports: number;
  failed: number;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Deletes raw log entries past retention, oldest first, at most RAW_EVENT_CAP. An entry is kept
 * while it is the newest for its gid by log order or by store time, because a replay rebuilds the
 * live row from whichever of those wins; only an entry a later-logged, later-dated one supersedes
 * goes. Columns hold UTC without a zone, so the cutoff is passed as a zone-less timestamp.
 */
export async function sweepRawEvents(prisma: PrismaClient, storeId: string, now: Date): Promise<SweepResult> {
  const dueBefore = form990DueBefore(now, RAW_EVENT_KEEP_YEARS).toISOString();
  try {
    const due = await prisma.$queryRaw<{ id: bigint }[]>`
      SELECT e.id FROM shopify_raw_event e
      WHERE e.store_id = ${storeId}
        AND COALESCE(e.occurred_at, e.fetched_at) < ${dueBefore}::timestamp
        AND EXISTS (
          SELECT 1 FROM shopify_raw_event n
          WHERE n.store_id = e.store_id
            AND n.object_type = e.object_type
            AND n.shopify_gid = e.shopify_gid
            AND n.id > e.id
            AND COALESCE(n.occurred_at, n.fetched_at) > COALESCE(e.occurred_at, e.fetched_at))
      ORDER BY e.id
      LIMIT ${RAW_EVENT_CAP}`;
    if (due.length === 0) return { deleted: 0, failed: 0 };
    const { count } = await prisma.shopifyRawEvent.deleteMany({ where: { id: { in: due.map((r) => r.id) } } });
    return { deleted: count, failed: 0 };
  } catch (err) {
    logger.error("raw log retention delete failed", { storeId, error: errorText(err) });
    return { deleted: 0, failed: 1 };
  }
}

/**
 * Deletes bulk exports whose run ended over 90 days ago, oldest first, at most EXPORT_CAP. An export
 * with no run, or whose run never finished, is dated by its capture.
 */
export async function sweepExports(prisma: PrismaClient, storeId: string, now: Date): Promise<SweepResult> {
  const cutoff = new Date(now.getTime() - EXPORT_KEEP_MS);
  // A run ends after it captures its export, so only an export captured before the cutoff can be due.
  const captured = await prisma.shopifyBulkExport.findMany({
    where: { storeId, fetchedAt: { lt: cutoff } },
    select: { id: true, syncRunId: true, fetchedAt: true },
    orderBy: { id: "asc" },
  });
  const runIds = [...new Set(captured.flatMap((e) => (e.syncRunId === null ? [] : [e.syncRunId])))];
  const runs = runIds.length === 0
    ? []
    : await prisma.syncRun.findMany({ where: { id: { in: runIds } }, select: { id: true, finishedAt: true } });
  const endedAt = new Map(runs.map((r) => [r.id, r.finishedAt]));
  const due = captured.filter((e) => ((e.syncRunId === null ? null : endedAt.get(e.syncRunId)) ?? e.fetchedAt) < cutoff);

  let deleted = 0;
  let failed = 0;
  for (const { id } of due.slice(0, EXPORT_CAP)) {
    try {
      deleted += (await prisma.shopifyBulkExport.deleteMany({ where: { id } })).count;
    } catch (err) {
      failed++;
      logger.error("bulk export retention delete failed", { storeId, exportId: id.toString(), error: errorText(err) });
    }
  }
  return { deleted, failed };
}

/** One capped retention pass for a store, under the store's run lock so no sync or replay interleaves. */
export function runRetention(prisma: PrismaClient, storeId: string, now: Date = new Date()): Promise<RetentionResult> {
  return withSyncRun(prisma, storeId, SyncKind.ADMIN, RETENTION_SCOPE, async () => {
    const raw = await sweepRawEvents(prisma, storeId, now);
    const exp = await sweepExports(prisma, storeId, now);
    return { rawEvents: raw.deleted, exports: exp.deleted, failed: raw.failed + exp.failed };
  }, { actor: RETENTION_ACTOR, reason: "retention period ended" });
}
