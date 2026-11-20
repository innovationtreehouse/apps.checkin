// Retention steps for the host's daily cron: held mail nobody acts on is discarded, and stored
// files past the Board's retention period are deleted. Each is idempotent, capped, and returns
// counts only.
import { db } from "../db";
import { audit } from "../repositories/receipt";
import { fileStore, getOrgId } from "../runtime";
import { RETENTION_FILE_DELETED } from "../lib/fileStorage";
import { BODY_COPY_DISCARDED } from "../lib/receipt-flow";
import { CATCH_UP_CAP } from "./catchUp";
import { closeUnreplyable } from "./mailReplies";
import { auditItem } from "./mailQueueService";

const DAY_MS = 24 * 60 * 60 * 1000;
export const HELD_MAIL_DISCARD_AFTER_MS = 90 * DAY_MS;
export const AUTO_DISCARD_REASON = "Held 90 days with no action";
/** How long prod keeps a deleted object restorable; a discarded mail item's key names it until then. */
export const RESTORE_WINDOW_MS = 30 * DAY_MS;

// The organization's fiscal year ends June 30, so its Form 990 is due November 15.
const FISCAL_YEAR_END_MONTH = 6;
const FORM_990_DUE = { month: 11, day: 15 };
const APPROVED_KEEP_YEARS = 7;
const ENDED_KEEP_YEARS = 1;

/** The audit actions that move a receipt into each kept-file state. */
const ENDING_ACTIONS: Record<string, string[]> = {
  receipt_finalized: ["finalized"],
  rejected: ["reject_financial"],
  discarded: ["discarded", BODY_COPY_DISCARDED],
};

const addYears = (at: Date, years: number) => {
  const d = new Date(at);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d;
};

/**
 * When a receipt's file may be deleted (Board B19), or null while it is kept. An approved receipt
 * is kept 7 years past its fiscal year's Form 990 deadline, dated by the receipt's date, else by its
 * approval; a rejected or discarded one 1 year past that decision. `endedAt` is when it entered its state.
 */
export function fileDeleteAfter(r: { state: string; receiptDate: string | null; approvedAt: Date | null; endedAt: Date | null }): Date | null {
  if (r.state === "receipt_finalized") {
    const day = r.receiptDate && /^\d{4}-\d{2}-\d{2}$/.test(r.receiptDate) ? r.receiptDate : (r.approvedAt ?? r.endedAt)?.toISOString();
    if (!day) return null;
    const year = Number(day.slice(0, 4));
    const fiscalYearEnd = Number(day.slice(5, 7)) > FISCAL_YEAR_END_MONTH ? year + 1 : year;
    // The day after the deadline: the file is kept through November 15 itself.
    return new Date(Date.UTC(fiscalYearEnd + APPROVED_KEEP_YEARS, FORM_990_DUE.month - 1, FORM_990_DUE.day + 1));
  }
  if (r.state === "rejected" || r.state === "discarded") return r.endedAt ? addYears(r.endedAt, ENDED_KEEP_YEARS) : null;
  return null;
}

/** A held mail item nobody assigned or discarded within 90 days of being held is discarded, as a finance discard is. */
export async function discardUnclaimedHeldMail(now = new Date()): Promise<{ discarded: number; failed: number }> {
  const cutoff = new Date(now.getTime() - HELD_MAIL_DISCARD_AFTER_MS);
  const stale = await db.receiptMailItem.findMany({
    // COALESCE(held_at, created_at): a hold written by code that predates held_at dates by its row.
    where: { orgId: await getOrgId(), status: "held", OR: [{ heldAt: { lt: cutoff } }, { heldAt: null, createdAt: { lt: cutoff } }] },
    select: { id: true, gmailMessageId: true },
    orderBy: { createdAt: "asc" },
    take: CATCH_UP_CAP,
  });
  let discarded = 0;
  let failed = 0;
  for (const { id, gmailMessageId } of stale) {
    try {
      const fileKey = await db.$transaction(async (tx) => {
        const moved = await tx.receiptMailItem.updateManyAndReturn({ where: { id, status: "held" }, data: { status: "discarded" }, select: { fileKey: true } });
        if (moved.length === 0) return undefined;
        await auditItem(tx, null, id, "mail_discarded", AUTO_DISCARD_REASON);
        await closeUnreplyable(tx, [gmailMessageId]);
        return moved[0].fileKey;
      });
      if (fileKey === undefined) continue;
      discarded++;
      // A failed delete leaves the object for sweepExpiredFiles, which deletes it again when it clears the key.
      if (fileKey) await fileStore().delete(fileKey);
    } catch (err) {
      failed++;
      console.error(`[receipt] held-mail auto-discard failed for mail item ${id}:`, err);
    }
  }
  return { discarded, failed };
}

/**
 * Deletes stored files whose retention has ended: a receipt's past its date, and a discarded mail
 * item's once its restore window has closed. The object goes first, so a crash between the two
 * leaves the key for the next run rather than a file nothing deletes. Each deletion is audited.
 */
export async function sweepExpiredFiles(now = new Date()): Promise<{ receiptFiles: number; mailFiles: number; failed: number }> {
  const orgId = await getOrgId();
  let failed = 0;
  const deleteThen = async (key: string, clear: () => Promise<boolean>, label: string): Promise<boolean> => {
    try {
      await fileStore().delete(key);
      return await clear();
    } catch (err) {
      failed++;
      console.error(`[receipt] retention delete failed for ${label}:`, err);
      return false;
    }
  };

  // A coarse cut in SQL: an approved receipt is due only once its date is over 7 years old, and an
  // ended one only once its decision is over a year old. fileDeleteAfter decides exactly.
  const approvedBefore = addYears(now, -APPROVED_KEEP_YEARS).toISOString().slice(0, 10);
  const endedBefore = addYears(now, -ENDED_KEEP_YEARS);
  const receipts = await db.receipt.findMany({
    where: {
      orgId,
      fileKey: { not: null },
      OR: [
        { details: { state: "receipt_finalized", OR: [{ receiptDate: { lt: approvedBefore } }, { receiptDate: null }] } },
        ...(["rejected", "discarded"] as const).map((state) => ({
          details: { state },
          auditLogs: { some: { action: { in: ENDING_ACTIONS[state] }, changedAt: { lt: endedBefore } } },
        })),
      ],
    },
    select: {
      id: true,
      fileKey: true,
      details: { select: { state: true, receiptDate: true, approvedAt: true } },
      auditLogs: { where: { action: { in: Object.values(ENDING_ACTIONS).flat() } }, select: { action: true, changedAt: true }, orderBy: { id: "desc" } },
    },
  });
  const dueReceipts = receipts.flatMap(({ id, fileKey, details, auditLogs }) => {
    if (!fileKey || !details) return [];
    const endedAt = auditLogs.find((a) => ENDING_ACTIONS[details.state].includes(a.action))?.changedAt ?? null;
    const after = fileDeleteAfter({ ...details, endedAt });
    return after && after <= now ? [{ id, fileKey }] : [];
  });
  let receiptFiles = 0;
  for (const { id, fileKey } of dueReceipts.slice(0, CATCH_UP_CAP)) {
    const cleared = await deleteThen(fileKey, () => db.$transaction(async (tx) => {
      const done = await tx.receipt.updateMany({ where: { id, fileKey }, data: { fileKey: null } });
      if (done.count === 0) return false;
      await audit(tx, id, null, { action: RETENTION_FILE_DELETED, fieldChanged: "fileKey", valueAfter: "retention period ended" });
      return true;
    }), `receipt ${id}`);
    if (cleared) receiptFiles++;
  }

  const discardedItems = await db.receiptMailItem.findMany({ where: { orgId, status: "discarded", fileKey: { not: null } }, select: { id: true, fileKey: true } });
  const discards = await db.receiptAuditLog.findMany({
    where: { action: "mail_discarded", fieldChanged: "mail_item", valueBefore: { in: discardedItems.map((i) => String(i.id)) } },
    select: { valueBefore: true, changedAt: true },
  });
  const windowClosed = new Date(now.getTime() - RESTORE_WINDOW_MS);
  const lastDiscard = new Map<string, Date>();
  for (const d of discards) {
    const key = d.valueBefore ?? "";
    const prev = lastDiscard.get(key);
    if (!prev || d.changedAt > prev) lastDiscard.set(key, d.changedAt);
  }
  const dueItems = discardedItems.filter((i) => {
    const at = lastDiscard.get(String(i.id));
    return at !== undefined && at < windowClosed;
  });
  let mailFiles = 0;
  for (const { id, fileKey } of dueItems.slice(0, CATCH_UP_CAP)) {
    if (!fileKey) continue;
    const cleared = await deleteThen(fileKey, () => db.$transaction(async (tx) => {
      const done = await tx.receiptMailItem.updateMany({ where: { id, fileKey }, data: { fileKey: null } });
      if (done.count === 0) return false;
      await auditItem(tx, null, id, "mail_file_deleted", "restore window ended");
      return true;
    }), `mail item ${id}`);
    if (cleared) mailFiles++;
  }
  return { receiptFiles, mailFiles, failed };
}
