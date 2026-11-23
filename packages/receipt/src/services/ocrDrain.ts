// The reading drain: reads receipts waiting in `ocr_queued`, oldest first, after the mail run's
// capture and under its lease. An upload's own background read claims its receipt the same way,
// so no receipt is read twice.
import { db } from "../db";
import { DeadlineError } from "../lib/deadline";
import { withLivePeople } from "../lib/livePeople";
import { getOrgId, ports } from "../runtime";
import { discardBodyCopy, readQueued } from "./receiptService";

/** Readings per drain, one at a time; the rest wait for the next run. */
export const DRAIN_CAP = 20;
/** Wall time of one drain. */
export const DRAIN_BUDGET_MS = 10 * 60_000;

export type DrainCounts = {
  /** Readings started: each landed in `uploaded` (then the pipeline) or `ocr_failed`. */
  read: number;
  /** Readings that threw; each is left in `auto_upload` for the interrupted-OCR sweep. */
  failed: number;
  /** Receipts still waiting when the drain ended. */
  waiting: number;
};

/** A body read beside its message's other receipts is discarded when its reading repeats one of them. */
async function discardIfCopy(gmailMessageId: string, receiptId: string): Promise<void> {
  const siblings = await db.receiptMailItem.findMany({
    where: { gmailMessageId, receiptId: { not: null }, NOT: { receiptId } },
    select: { receiptId: true },
  });
  try {
    await discardBodyCopy(receiptId, siblings.flatMap((s) => (s.receiptId ? [s.receiptId] : [])));
  } catch (err) {
    // The body stays its own receipt; finance discards it the ordinary way.
    console.error("[receipt] body copy check failed for one receipt:", err);
  }
}

/** After a mailed body is read, discards it when it repeats a receipt from its own message. */
export async function settleMailedBody(receiptId: string): Promise<void> {
  const receipt = await db.receipt.findUnique({ where: { id: receiptId }, select: { intakeSource: true, mimeType: true } });
  if (receipt?.intakeSource !== "email" || receipt.mimeType !== "text/plain") return;
  const item = await db.receiptMailItem.findFirst({ where: { receiptId }, select: { gmailMessageId: true } });
  if (item) await discardIfCopy(item.gmailMessageId, receiptId);
}

/**
 * Reads up to `cap` queued receipts, oldest `ocrQueuedAt` first, each charged to its uploader's
 * allowance. Stops at `deadline` (epoch ms), or at the first call that ran past it. A receipt
 * another reader claimed first is skipped. Mailed bodies are checked for copies once every reading
 * is done, so a body is compared with its message's other receipts as read.
 */
export async function drainOcrQueue(deadline: number, cap = DRAIN_CAP): Promise<DrainCounts> {
  const orgId = await getOrgId();
  const rows = await db.receiptDetail.findMany({
    where: { orgId, state: "ocr_queued" },
    select: { id: true, receipt: { select: { uploadedByUserId: true } } },
    orderBy: [{ ocrQueuedAt: "asc" }, { id: "asc" }],
    take: cap,
  });
  const queued = await withLivePeople(rows.map((r) => ({ id: r.id, uploadedByUserId: r.receipt.uploadedByUserId })));
  const read: string[] = [];
  let failed = 0;
  for (const { id, uploadedByUserId } of queued) {
    if (Date.now() >= deadline) break;
    try {
      const uploader = await ports().reimbursees.byId(uploadedByUserId);
      if (!(await readQueued(id, { id: uploadedByUserId, name: uploader?.name ?? null }, deadline))) continue;
      read.push(id);
    } catch (err) {
      failed++;
      console.error(`[receipt] OCR failed for ${id}:`, err);
      if (err instanceof DeadlineError) break;
    }
  }
  for (const id of read) await settleMailedBody(id);
  return { read: read.length, failed, waiting: await db.receiptDetail.count({ where: { orgId, state: "ocr_queued" } }) };
}
