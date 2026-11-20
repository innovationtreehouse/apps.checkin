/** The daily retention steps: held mail nobody acts on is discarded, and files past retention are deleted from the store. */
import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { db } from "../../db";
import { fileStore } from "../../runtime";
import { AUTO_DISCARD_REASON, HELD_MAIL_DISCARD_AFTER_MS, RESTORE_WINDOW_MS, discardUnclaimedHeldMail, sweepExpiredFiles } from "../../services/retention";
import { describeDb } from "../helpers/db";
import { ALICE, FINANCE, TEST_ORG_ID, actAs, clearAll, configure, storeFile, storedBytes } from "../helpers/setup";
import { receiptService } from "../../services/receiptService";

const NOW = new Date("2034-01-01T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
let seq = 0;

async function receiptIn(state: string, opts: { receiptDate?: string; endedBy?: [action: string, at: Date]; orgId?: string } = {}): Promise<{ id: string; fileKey: string }> {
  const id = randomUUID();
  const orgId = opts.orgId ?? TEST_ORG_ID;
  const fileKey = await storeFile(Buffer.from(`receipt ${++seq}`), id);
  await db.receipt.create({
    data: {
      id, orgId, uploadedByUserId: ALICE.id, fileKey, fileHash: randomUUID(), mimeType: "text/plain",
      details: { create: { orgId, state, receiptDate: opts.receiptDate ?? null } },
    },
  });
  if (opts.endedBy) await db.receiptAuditLog.create({ data: { receiptId: id, action: opts.endedBy[0], changedAt: opts.endedBy[1] } });
  return { id, fileKey };
}

async function mailItem(status: string, createdAt: Date, heldAt: Date | null = status === "held" ? createdAt : null): Promise<{ id: number; fileKey: string }> {
  const n = ++seq;
  const fileKey = await storeFile(Buffer.from(`%PDF-1.4 held ${n}`));
  const { id } = await db.receiptMailItem.create({
    data: { orgId: TEST_ORG_ID, gmailMessageId: `m${n}`, attachmentHash: `h${n}`, receivedAt: createdAt, senderAddress: "stranger@elsewhere.test", status, fileKey, mimeType: "application/pdf", createdAt, heldAt },
  });
  return { id, fileKey };
}

const keyOf = async (id: string) => (await db.receipt.findUniqueOrThrow({ where: { id }, select: { fileKey: true } })).fileKey;
const itemOf = (id: number) => db.receiptMailItem.findUniqueOrThrow({ where: { id }, select: { status: true, fileKey: true } });
const itemAudit = (id: number) => db.receiptAuditLog.findMany({ where: { fieldChanged: "mail_item", valueBefore: String(id) }, select: { action: true, userId: true, valueAfter: true }, orderBy: { id: "asc" } });

beforeEach(async () => {
  await clearAll();
  configure();
});

describeDb("held-mail auto-discard", () => {
  it("discards a held item 90 days after it was held, audited as a system discard, and deletes its file", async () => {
    const old = await mailItem("held", new Date(NOW.getTime() - HELD_MAIL_DISCARD_AFTER_MS - DAY));
    const young = await mailItem("held", new Date(NOW.getTime() - HELD_MAIL_DISCARD_AFTER_MS + DAY));
    const deferred = await mailItem("deferred", new Date(NOW.getTime() - 2 * HELD_MAIL_DISCARD_AFTER_MS));

    expect(await discardUnclaimedHeldMail(NOW)).toEqual({ discarded: 1, failed: 0 });

    expect(await itemOf(old.id)).toEqual({ status: "discarded", fileKey: old.fileKey });
    expect(await itemAudit(old.id)).toEqual([{ action: "mail_discarded", userId: null, valueAfter: AUTO_DISCARD_REASON }]);
    expect(await storedBytes(old.fileKey)).toBe("");
    expect((await itemOf(young.id)).status).toBe("held");
    expect((await itemOf(deferred.id)).status).toBe("deferred");
    expect(await discardUnclaimedHeldMail(NOW)).toEqual({ discarded: 0, failed: 0 });
  });

  it("counts 90 days from when a deferred item became held, not from when it arrived", async () => {
    const lateHeld = await mailItem("held", new Date(NOW.getTime() - 3 * HELD_MAIL_DISCARD_AFTER_MS), new Date(NOW.getTime() - DAY));

    expect(await discardUnclaimedHeldMail(NOW)).toEqual({ discarded: 0, failed: 0 });
    expect((await itemOf(lateHeld.id)).status).toBe("held");
  });

  it("dates a hold with no heldAt, written by older code, by when its row was written", async () => {
    const old = await mailItem("held", new Date(NOW.getTime() - HELD_MAIL_DISCARD_AFTER_MS - DAY), null);
    const young = await mailItem("held", new Date(NOW.getTime() - HELD_MAIL_DISCARD_AFTER_MS + DAY), null);

    expect(await discardUnclaimedHeldMail(NOW)).toEqual({ discarded: 1, failed: 0 });
    expect((await itemOf(old.id)).status).toBe("discarded");
    expect((await itemOf(young.id)).status).toBe("held");
  });

  it("counts a failed file delete as a failure; the item stays discarded and keeps its key", async () => {
    const old = await mailItem("held", new Date(NOW.getTime() - HELD_MAIL_DISCARD_AFTER_MS - DAY));
    vi.spyOn(fileStore(), "delete").mockRejectedValueOnce(new Error("store down"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await discardUnclaimedHeldMail(NOW)).toEqual({ discarded: 1, failed: 1 });
    expect(await itemOf(old.id)).toEqual({ status: "discarded", fileKey: old.fileKey });
    vi.restoreAllMocks();
  });
});

describeDb("file retention", () => {
  it("deletes an approved receipt's file only once its fiscal year's retention has ended, and audits it", async () => {
    // Fiscal year July 2025 – June 2026: its 990 is due November 15, 2026, so the file goes after November 15, 2033.
    const due = await receiptIn("receipt_finalized", { receiptDate: "2026-06-30" });
    const kept = await receiptIn("receipt_finalized", { receiptDate: "2026-07-01" });

    expect(await sweepExpiredFiles(new Date("2033-11-15T23:59:59Z"))).toEqual({ receiptFiles: 0, mailFiles: 0, failed: 0 });
    expect(await sweepExpiredFiles(NOW)).toEqual({ receiptFiles: 1, mailFiles: 0, failed: 0 });

    expect(await keyOf(due.id)).toBeNull();
    expect(await storedBytes(due.fileKey)).toBe("");
    expect(await db.receiptAuditLog.findMany({ where: { receiptId: due.id }, select: { action: true, userId: true, fieldChanged: true } }))
      .toEqual([{ action: "file_deleted", userId: null, fieldChanged: "fileKey" }]);
    expect(await keyOf(kept.id)).toBe(kept.fileKey);
    expect(await storedBytes(kept.fileKey)).not.toBe("");
  });

  it("deletes a rejected or discarded receipt's file a year after that decision, never an undecided one's", async () => {
    const rejected = await receiptIn("rejected", { endedBy: ["reject_financial", new Date(NOW.getTime() - 366 * DAY)] });
    const discarded = await receiptIn("discarded", { endedBy: ["discarded", new Date(NOW.getTime() - 366 * DAY)] });
    const recent = await receiptIn("rejected", { endedBy: ["reject_financial", new Date(NOW.getTime() - 300 * DAY)] });
    const waiting = await receiptIn("financial_review", { receiptDate: "2001-01-01" });
    const otherOrg = await receiptIn("discarded", { endedBy: ["discarded", new Date(0)], orgId: "00000000-0000-0000-0000-000000000099" });

    expect(await sweepExpiredFiles(NOW)).toEqual({ receiptFiles: 2, mailFiles: 0, failed: 0 });

    expect(await keyOf(rejected.id)).toBeNull();
    expect(await keyOf(discarded.id)).toBeNull();
    for (const r of [recent, waiting, otherOrg]) expect(await keyOf(r.id)).toBe(r.fileKey);
  });

  it("answers 404 for a file retention deleted without logging an error, and still logs a key missing otherwise", async () => {
    const retired = await receiptIn("discarded", { endedBy: ["discarded", new Date(0)] });
    const lost = await receiptIn("discarded", { endedBy: ["discarded", new Date(NOW.getTime() - DAY)] });
    await sweepExpiredFiles(NOW);
    await db.receipt.update({ where: { id: lost.id }, data: { fileKey: null } });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    actAs(FINANCE);

    await expect(receiptService.getFile(retired.id, "finance")).rejects.toMatchObject({ status: 404 });
    expect(logged).not.toHaveBeenCalled();
    await expect(receiptService.getFile(lost.id, "finance")).rejects.toMatchObject({ status: 404 });
    expect(logged).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it("keeps the key when the store delete fails, so the next run tries again", async () => {
    const r = await receiptIn("discarded", { endedBy: ["discarded", new Date(0)] });
    vi.spyOn(fileStore(), "delete").mockRejectedValueOnce(new Error("store down"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await sweepExpiredFiles(NOW)).toEqual({ receiptFiles: 0, mailFiles: 0, failed: 1 });
    expect(await keyOf(r.id)).toBe(r.fileKey);

    expect(await sweepExpiredFiles(NOW)).toEqual({ receiptFiles: 1, mailFiles: 0, failed: 0 });
    expect(await keyOf(r.id)).toBeNull();
    vi.restoreAllMocks();
  });

  it("clears a discarded mail item's key once its restore window has closed", async () => {
    const closed = await mailItem("discarded", new Date(0));
    const open = await mailItem("discarded", new Date(0));
    const audit = (id: number, at: Date) => db.receiptAuditLog.create({ data: { action: "mail_discarded", fieldChanged: "mail_item", valueBefore: String(id), changedAt: at } });
    await audit(closed.id, new Date(NOW.getTime() - RESTORE_WINDOW_MS - DAY));
    await audit(open.id, new Date(NOW.getTime() - RESTORE_WINDOW_MS + DAY));

    expect(await sweepExpiredFiles(NOW)).toEqual({ receiptFiles: 0, mailFiles: 1, failed: 0 });

    expect(await itemOf(closed.id)).toEqual({ status: "discarded", fileKey: null });
    expect((await itemAudit(closed.id)).map((a) => a.action)).toEqual(["mail_discarded", "mail_file_deleted"]);
    expect(await storedBytes(closed.fileKey)).toBe("");
    expect(await itemOf(open.id)).toEqual({ status: "discarded", fileKey: open.fileKey });
  });
});
