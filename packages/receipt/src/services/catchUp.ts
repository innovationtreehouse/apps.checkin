// Catch-up steps for the host's existing daily cron handler. Each is idempotent, capped,
// and returns counts only. Nothing here runs at boot or on its own schedule.
import { db } from "../db";
import { sendDonorSync } from "../lib/donor-sync";
import { pushReceipt } from "../lib/receipt-flow";
import { audit } from "../repositories/receipt";
import { getOrg } from "../runtime";

export const OCR_INTERRUPTED_AFTER_MS = 10 * 60 * 1000;
export const CATCH_UP_CAP = 50;

/** A receipt left in `auto_upload` by a process that died mid-OCR moves to `ocr_failed`. */
export async function sweepInterruptedOcr(now = new Date()): Promise<{ swept: number }> {
  const orgId = (await getOrg()).id;
  const stuck = await db.receiptDetail.findMany({
    where: { orgId, state: "auto_upload", ocrStartedAt: { lt: new Date(now.getTime() - OCR_INTERRUPTED_AFTER_MS) } },
    select: { id: true },
  });
  let swept = 0;
  for (const { id } of stuck) {
    await db.$transaction(async (tx) => {
      const moved = await tx.receiptDetail.updateMany({
        where: { id, state: "auto_upload" },
        data: { state: "ocr_failed", validationNotes: "OCR failed: interrupted" },
      });
      if (moved.count === 0) return;
      await audit(tx, id, null, { action: "ocr_failed", valueAfter: "interrupted" });
      swept++;
    });
  }
  return { swept };
}

/** Catch-up stops retrying a receipt after this many system push failures in a row. */
export const MAX_CONSECUTIVE_PUSH_FAILURES = 5;

/**
 * Ids whose latest MAX_CONSECUTIVE_PUSH_FAILURES push attempts are all catch-up failures.
 * A success or a manual push (one with an acting user) ends the run, and so does any
 * delivery in the org since: the receiver accepting a push means it may accept these too.
 */
export async function givenUp(orgId: string, ids: string[]): Promise<Set<string>> {
  const lastDelivery = await db.receiptAuditLog.findFirst({
    where: { action: "pushed", receipt: { orgId } },
    select: { id: true },
    orderBy: { id: "desc" },
  });
  const log = await db.receiptAuditLog.findMany({
    where: { receiptId: { in: ids }, action: { in: ["pushed", "push_failed"] }, id: { gt: lastDelivery?.id ?? 0 } },
    select: { receiptId: true, action: true, userId: true },
    orderBy: { id: "desc" },
  });
  const run = new Map<string, number>();
  const ended = new Set<string>();
  for (const { receiptId, action, userId } of log) {
    if (!receiptId || ended.has(receiptId)) continue;
    if (action === "push_failed" && userId === null) run.set(receiptId, (run.get(receiptId) ?? 0) + 1);
    else ended.add(receiptId);
  }
  return new Set([...run].filter(([, n]) => n >= MAX_CONSECUTIVE_PUSH_FAILURES).map(([id]) => id));
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
      where: { receiptId: { in: ids }, action: "push_failed" },
      select: { receiptId: true, changedAt: true, valueAfter: true },
      orderBy: { id: "desc" },
      distinct: ["receiptId"],
    }),
  ]);
  const latest = new Map(failures.map((f) => [f.receiptId, f]));
  return new Map(
    ids.map((id) => {
      const failure = latest.get(id);
      return [id, { pushGivenUp: skip.has(id), lastPushFailedAt: failure?.changedAt ?? null, lastPushFailure: failure?.valueAfter ?? null }];
    }),
  );
}

/** S1 re-push of finalized receipts not yet delivered, skipping ones catch-up has given up on. */
export async function repushUnpushed(): Promise<{ pushed: number; failed: number; skipped: number }> {
  const orgId = (await getOrg()).id;
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
    where: { orgId: (await getOrg()).id, donorSync: "pending" },
    select: { id: true },
    orderBy: { uploadedAt: "asc" },
    take: CATCH_UP_CAP,
  });
  let resent = 0;
  for (const { id } of rows) if (await sendDonorSync(id, null)) resent++;
  return { resent, failed: rows.length - resent };
}
