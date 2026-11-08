// Catch-up steps for the host's existing daily cron handler. Each is idempotent, capped,
// and returns counts only. Nothing here runs at boot or on its own schedule.
import { db } from "../db";
import { sendDonorSync } from "../lib/donor-sync";
import { pushReceipt } from "../lib/receipt-flow";
import { audit } from "../repositories/receipt";
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
        swept++;
      })
      .catch((err) => {
        failed++;
        console.error(`[receipt] stuck-upload sweep failed for receipt ${id}:`, err);
      });
  }
  return { swept, failed };
}

/** Catch-up stops retrying a receipt after this many catch-up bug failures in a row. */
export const MAX_CONSECUTIVE_PUSH_FAILURES = 5;

/**
 * Ids catch-up has given up on. A refusal gives up at once. A bug gives up a receipt once its
 * latest MAX_CONSECUTIVE_PUSH_FAILURES catch-up bug failures run unbroken; a success or a manual
 * push (one with an acting user) ends the run. An outage (system, connection, settings) is never
 * charged to the receipt: it neither counts nor ends a run. A `push_failed` row with no kind
 * predates kinds and reads as an outage.
 */
export async function givenUp(orgId: string, ids: string[]): Promise<Set<string>> {
  const log = await db.receiptAuditLog.findMany({
    where: { receiptId: { in: ids }, receipt: { orgId }, action: { in: ["pushed", "push_failed", "push_refused"] } },
    select: { receiptId: true, action: true, userId: true, valueBefore: true },
    orderBy: { id: "desc" },
  });
  const run = new Map<string, number>();
  const ended = new Set<string>();
  const out = new Set<string>();
  for (const { receiptId, action, userId, valueBefore } of log) {
    if (!receiptId || ended.has(receiptId)) continue;
    if (action !== "push_failed" || userId !== null) {
      ended.add(receiptId);
      if (action === "push_refused") out.add(receiptId);
      continue;
    }
    if (valueBefore !== "bug") continue;
    const failures = (run.get(receiptId) ?? 0) + 1;
    run.set(receiptId, failures);
    if (failures >= MAX_CONSECUTIVE_PUSH_FAILURES) {
      out.add(receiptId);
      ended.add(receiptId);
    }
  }
  return out;
}

/** Where a finalized, not-yet-delivered receipt stands with catch-up, for the review screen. */
export interface PushRecord {
  pushGivenUp: boolean;
  lastPushFailedAt: Date | null;
  lastPushFailure: string | null;
}

/** The push record of each of `ids`, all of which should be finalized and not yet delivered. */
export async function pushRecords(orgId: string, ids: string[]): Promise<Map<string, PushRecord>> {
  if (ids.length === 0) return new Map();
  const [skip, failures] = await Promise.all([
    givenUp(orgId, ids),
    db.receiptAuditLog.findMany({
      where: { receiptId: { in: ids }, action: { in: ["push_failed", "push_refused"] } },
      select: { receiptId: true, changedAt: true, valueAfter: true },
      orderBy: [{ receiptId: "asc" }, { id: "desc" }],
      distinct: ["receiptId"],
    }),
  ]);
  // Rows come newest first within each receipt; the first one seen is the latest.
  const latest = new Map<string | null, (typeof failures)[number]>();
  for (const f of failures) if (!latest.has(f.receiptId)) latest.set(f.receiptId, f);
  return new Map(
    ids.map((id) => {
      const failure = latest.get(id);
      return [id, { pushGivenUp: skip.has(id), lastPushFailedAt: failure?.changedAt ?? null, lastPushFailure: failure?.valueAfter ?? null }];
    }),
  );
}

/** S1 re-push of finalized receipts not yet delivered, skipping ones catch-up has given up on. */
export async function repushUnpushed(): Promise<{ pushed: number; failed: number; skipped: number }> {
  const orgId = await getOrgId();
  const rows = await db.receipt.findMany({
    where: { orgId, pushedAt: null, details: { state: "receipt_finalized" } },
    select: { id: true },
    orderBy: { uploadedAt: "asc" },
  });
  const skip = await givenUp(orgId, rows.map((r) => r.id));
  const due = rows.filter((r) => !skip.has(r.id)).slice(0, CATCH_UP_CAP);
  let pushed = 0;
  for (const { id } of due) if (await pushReceipt(id, null)) pushed++;
  return { pushed, failed: due.length - pushed, skipped: skip.size };
}

/** X13 re-send for receipts whose donor change donations has not heard. */
export async function resendDonorSync(): Promise<{ resent: number; failed: number }> {
  const rows = await db.receipt.findMany({
    where: { orgId: await getOrgId(), donorSync: "pending" },
    select: { id: true },
    orderBy: { uploadedAt: "asc" },
    take: CATCH_UP_CAP,
  });
  let resent = 0;
  for (const { id } of rows) if (await sendDonorSync(id, null)) resent++;
  return { resent, failed: rows.length - resent };
}
