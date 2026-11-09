// Sweeps for the host's existing daily cron handler. Each moves stranded receipts to a state a
// person acts on; none retries a step. Each is idempotent, capped, and returns counts only.
// Nothing here runs at boot or on its own schedule.
import { db } from "../db";
import { audit, recordFailure } from "../repositories/receipt";
import { getOrgId } from "../runtime";

export const OCR_INTERRUPTED_AFTER_MS = 10 * 60 * 1000;
export const CATCH_UP_CAP = 50;

/** A receipt left in `auto_upload` by a process that died mid-OCR moves to `ocr_failed`. */
export async function sweepInterruptedOcr(now = new Date()): Promise<{ swept: number; failed: number }> {
  const orgId = await getOrgId();
  const stuck = await db.receiptDetail.findMany({
    where: { orgId, state: "auto_upload", ocrStartedAt: { lt: new Date(now.getTime() - OCR_INTERRUPTED_AFTER_MS) } },
    select: { id: true },
    orderBy: { ocrStartedAt: "asc" },
    take: CATCH_UP_CAP,
  });
  let swept = 0;
  let failed = 0;
  for (const { id } of stuck) {
    // One row failing leaves it for the next run; the rest still move.
    await db
      .$transaction(async (tx) => {
        const moved = await tx.receiptDetail.updateMany({
          where: { id, state: "auto_upload" },
          data: { state: "ocr_failed", validationNotes: 'Automatic reading was interrupted. Press "Read it again", or type the details.' },
        });
        if (moved.count === 0) return;
        await audit(tx, id, null, { action: "ocr_failed", valueAfter: "interrupted" });
        swept++;
      })
      .catch((err) => {
        failed++;
        console.error(`[receipt] interrupted OCR sweep failed for receipt ${id}:`, err);
      });
  }
  return { swept, failed };
}

export const STUCK_UPLOADED_AFTER_MS = 60 * 60 * 1000;

/**
 * A receipt left in `uploaded` by a flow that never ran its checks moves to `flow_error`, which
 * finance's queue lists and can restart. Its last audit entry (or its upload) dates the wait.
 */
export async function sweepStuckUploaded(now = new Date()): Promise<{ swept: number; failed: number }> {
  const cutoff = new Date(now.getTime() - STUCK_UPLOADED_AFTER_MS);
  const rows = await db.receipt.findMany({
    where: { orgId: await getOrgId(), details: { state: "uploaded" } },
    select: { id: true, uploadedAt: true, auditLogs: { select: { changedAt: true }, orderBy: { id: "desc" }, take: 1 } },
  });
  const stuck = rows.filter((r) => (r.auditLogs[0]?.changedAt ?? r.uploadedAt) < cutoff).slice(0, CATCH_UP_CAP);
  let swept = 0;
  let failed = 0;
  for (const { id } of stuck) {
    // One row failing leaves it for the next run; the rest still move.
    await db
      .$transaction(async (tx) => {
        const moved = await tx.receiptDetail.updateMany({
          where: { id, state: "uploaded" },
          data: { state: "flow_error", validationNotes: "The automatic checks stopped before finishing. Restart the flow." },
        });
        if (moved.count === 0) return;
        await audit(tx, id, null, { action: "pipeline_failed", fieldChanged: "state", valueBefore: "uploaded", valueAfter: "stuck in uploaded" });
        await recordFailure(tx, id, "stuck in uploaded");
        swept++;
      })
      .catch((err) => {
        failed++;
        console.error(`[receipt] stuck-upload sweep failed for receipt ${id}:`, err);
      });
  }
  return { swept, failed };
}
