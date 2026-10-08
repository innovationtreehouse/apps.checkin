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
  const orgId = getOrg().id;
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

/** S1 re-push of finalized receipts not yet delivered. */
export async function repushUnpushed(): Promise<{ pushed: number; failed: number }> {
  const rows = await db.receipt.findMany({
    where: { orgId: getOrg().id, pushedAt: null, details: { state: "receipt_finalized" } },
    select: { id: true },
    orderBy: { uploadedAt: "asc" },
    take: CATCH_UP_CAP,
  });
  let pushed = 0;
  for (const { id } of rows) if (await pushReceipt(id, null)) pushed++;
  return { pushed, failed: rows.length - pushed };
}

/** X13 re-send for receipts whose donor change donations has not heard. */
export async function resendDonorSync(): Promise<{ resent: number; failed: number }> {
  const rows = await db.receipt.findMany({
    where: { orgId: getOrg().id, donorSync: "pending" },
    select: { id: true },
    orderBy: { uploadedAt: "asc" },
    take: CATCH_UP_CAP,
  });
  let resent = 0;
  for (const { id } of rows) if (await sendDonorSync(id, null)) resent++;
  return { resent, failed: rows.length - resent };
}
