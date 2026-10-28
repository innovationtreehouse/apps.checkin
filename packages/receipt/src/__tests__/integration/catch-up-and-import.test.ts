import { beforeEach, expect, it } from "vitest";
import { db } from "../../db";
import { MAX_CONSECUTIVE_PUSH_FAILURES, pushRecords, repushUnpushed, sweepInterruptedOcr, sweepStuckUploaded } from "../../services/catchUp";
import { insertReceiptsTogether } from "../../lib/insert";
import { importReceipts } from "../../services/importService";
import { receiptService } from "../../services/receiptService";
import { describeDb } from "../helpers/db";
import { ALICE, FINANCE, TEST_ORG_ID, actAs, clearAll, configure, manualDetails, recordingPorts, stateOf, textFile } from "../helpers/setup";

let ports: ReturnType<typeof recordingPorts>;

beforeEach(async () => {
  await clearAll();
  actAs(ALICE);
  ports = recordingPorts();
  configure({ receiptSink: ports.receiptSink });
});

describeDb("catch-up steps", () => {
  it("re-pushes finalized receipts whose push failed, and counts only", async () => {
    ports.fail.push = true;
    const r = await receiptService.upload(textFile(), "text/plain", { details: manualDetails() });
    ports.fail.push = false;
    expect(await repushUnpushed()).toEqual({ pushed: 1, failed: 0, skipped: 0 });
    expect((await db.receipt.findUniqueOrThrow({ where: { id: r.id } })).pushedAt).not.toBeNull();
    expect(await repushUnpushed()).toEqual({ pushed: 0, failed: 0, skipped: 0 });
  });

  it("retries a failing receipt until MAX_CONSECUTIVE_PUSH_FAILURES catch-up failures, then skips it", async () => {
    ports.fail.push = true;
    await receiptService.upload(textFile(), "text/plain", { details: manualDetails() });
    for (let i = 0; i < MAX_CONSECUTIVE_PUSH_FAILURES; i++) {
      expect(await repushUnpushed()).toEqual({ pushed: 0, failed: 1, skipped: 0 });
    }
    const attempts = ports.calls.pushes.length;
    expect(await repushUnpushed()).toEqual({ pushed: 0, failed: 0, skipped: 1 });
    expect(ports.calls.pushes).toHaveLength(attempts);
  });

  it("retries a skipped receipt again after a manual push, and delivers it once the push succeeds", async () => {
    ports.fail.push = true;
    const r = await receiptService.upload(textFile(), "text/plain", { details: manualDetails() });
    for (let i = 0; i < MAX_CONSECUTIVE_PUSH_FAILURES; i++) await repushUnpushed();
    expect(await repushUnpushed()).toMatchObject({ skipped: 1 });

    actAs(FINANCE);
    expect(await receiptService.push(r.id)).toEqual({ pushed: false });
    expect(await repushUnpushed()).toEqual({ pushed: 0, failed: 1, skipped: 0 });

    ports.fail.push = false;
    expect(await repushUnpushed()).toEqual({ pushed: 1, failed: 0, skipped: 0 });
    expect((await db.receipt.findUniqueOrThrow({ where: { id: r.id } })).pushedAt).not.toBeNull();
  });

  it("retries a skipped receipt on the run after another receipt is delivered", async () => {
    ports.fail.push = true;
    const stuck = await receiptService.upload(textFile(), "text/plain", { details: manualDetails() });
    for (let i = 0; i < MAX_CONSECUTIVE_PUSH_FAILURES; i++) await repushUnpushed();
    await receiptService.upload(textFile(), "text/plain", { details: manualDetails({ retailer: "Other Store" }) });

    ports.fail.push = false;
    expect(await repushUnpushed()).toEqual({ pushed: 1, failed: 0, skipped: 1 });
    expect(await repushUnpushed()).toEqual({ pushed: 1, failed: 0, skipped: 0 });
    expect((await db.receipt.findUniqueOrThrow({ where: { id: stuck.id } })).pushedAt).not.toBeNull();
  });

  it("lists an undelivered receipt with its latest failure, marked once catch-up gives up", async () => {
    ports.fail.push = true;
    const r = await receiptService.upload(textFile(), "text/plain", { details: manualDetails() });
    actAs(FINANCE);
    const undelivered = () => receiptService.list({ state: "receipt_finalized", pushed: false });

    expect(await undelivered()).toEqual([
      expect.objectContaining({ id: r.id, pushGivenUp: false, lastPushFailure: "workflow-mapping down", lastPushFailedAt: expect.any(Date) }),
    ]);
    for (let i = 0; i < MAX_CONSECUTIVE_PUSH_FAILURES; i++) await repushUnpushed();
    expect(await undelivered()).toEqual([expect.objectContaining({ id: r.id, pushGivenUp: true })]);

    ports.fail.push = false;
    await receiptService.push(r.id);
    expect(await undelivered()).toEqual([]);
    expect((await receiptService.list({ state: "receipt_finalized" }))[0]).not.toHaveProperty("pushGivenUp");
  });

  it("reports each receipt's latest push failure, whatever order the receipts' failures interleave in", async () => {
    ports.fail.push = true;
    const a = await receiptService.upload(textFile(), "text/plain", { details: manualDetails() });
    const b = await receiptService.upload(textFile(), "text/plain", { details: manualDetails({ retailer: "Other Store" }) });
    for (const [id, message] of [[a.id, "a second"], [b.id, "b second"], [a.id, "a latest"], [b.id, "b latest"]]) {
      await db.receiptAuditLog.create({ data: { receiptId: id, action: "push_failed", valueAfter: message } });
    }
    const records = await pushRecords((await db.receipt.findUniqueOrThrow({ where: { id: a.id } })).orgId, [a.id, b.id]);
    expect(records.get(a.id)?.lastPushFailure).toBe("a latest");
    expect(records.get(b.id)?.lastPushFailure).toBe("b latest");
  });

  it("counts each state, the undelivered receipts, and the ones catch-up gave up on", async () => {
    ports.fail.push = true;
    await receiptService.upload(textFile(), "text/plain", { details: manualDetails() });
    await receiptService.upload(textFile(), "text/plain", { details: manualDetails({ retailer: "Other Store" }) });
    actAs(FINANCE);
    expect(await receiptService.queueCounts(null)).toEqual({ byState: { receipt_finalized: 2 }, notPushed: 2, pushGivenUp: 0 });
    for (let i = 0; i < MAX_CONSECUTIVE_PUSH_FAILURES; i++) await repushUnpushed();
    expect(await receiptService.queueCounts(null)).toMatchObject({ notPushed: 2, pushGivenUp: 2 });
  });

  it("moves a receipt stuck in OCR for over ten minutes to ocr_failed", async () => {
    const stuck = await receiptService.upload(textFile(), "text/plain", {});
    await db.receiptDetail.update({ where: { id: stuck.id }, data: { state: "auto_upload", ocrStartedAt: new Date(Date.now() - 11 * 60_000) } });
    const fresh = await receiptService.upload(textFile(), "text/plain", {});
    await db.receiptDetail.update({ where: { id: fresh.id }, data: { state: "auto_upload", ocrStartedAt: new Date() } });

    expect(await sweepInterruptedOcr()).toEqual({ swept: 1 });
    expect(await stateOf(stuck.id)).toBe("ocr_failed");
    expect(await stateOf(fresh.id)).toBe("auto_upload");
  });

  it("moves a receipt resting in uploaded for over an hour to flow_error, once", async () => {
    const stuck = await receiptService.upload(textFile(), "text/plain", {});
    await db.receiptDetail.update({ where: { id: stuck.id }, data: { state: "uploaded" } });
    const fresh = await receiptService.upload(textFile(), "text/plain", {});
    await db.receiptDetail.update({ where: { id: fresh.id }, data: { state: "uploaded" } });
    const ocr = await receiptService.upload(textFile(), "text/plain", {});
    await db.receiptDetail.update({ where: { id: ocr.id }, data: { state: "auto_upload", ocrStartedAt: new Date() } });
    const later = new Date(Date.now() + 61 * 60_000);
    await db.receiptAuditLog.create({ data: { receiptId: fresh.id, action: "submitter_confirmed", changedAt: new Date(Date.now() + 30 * 60_000) } });

    expect(await sweepStuckUploaded(later)).toEqual({ swept: 1 });
    expect(await stateOf(stuck.id)).toBe("flow_error");
    expect(await stateOf(fresh.id)).toBe("uploaded");
    expect(await stateOf(ocr.id)).toBe("auto_upload");
    expect(await sweepStuckUploaded(later)).toEqual({ swept: 0 });
  });
});

const importRow = (importSourceId: string, over: Record<string, unknown> = {}) => ({
  importSourceId,
  qbTxnId: `qb-${importSourceId}`,
  qbEntity: "Purchase",
  retailer: `Store ${importSourceId}`,
  receiptDate: "2023-03-01",
  shippingCents: 0,
  taxCents: 0,
  discountCents: 0,
  receiptTotalCents: 500,
  mimeType: "text/plain",
  fileBase64: Buffer.from(`historical ${importSourceId}`).toString("base64"),
  lineItems: [{ lineNumber: 1, description: "Old thing", quantity: 1, unitPriceCents: 500, totalPriceCents: 500, isDelayed: false }],
  ...over,
});

describeDb("historical import", () => {
  it("runs the pipeline, waives submitter and age steps, pushes as backfill, and skips on re-run", async () => {
    actAs(FINANCE);
    const first = await importReceipts([importRow("u1")]);
    expect(first).toMatchObject({ processed: 1, skipped: 0, byState: { receipt_finalized: 1 } });
    expect(ports.calls.pushes[0]).toMatchObject({ backfill: true, needsReimbursement: false });
    expect(ports.calls.pushes[0].reimburseePersonId).toBeUndefined();

    const again = await importReceipts([importRow("u1")]);
    expect(again).toMatchObject({ processed: 0, skipped: 1 });
  });

  it("caps a batch at 50 and checks each file's bytes", async () => {
    actAs(FINANCE);
    await expect(importReceipts(Array.from({ length: 51 }, (_, i) => importRow(`b${i}`)))).rejects.toMatchObject({ status: 400 });
    await expect(importReceipts([importRow("bad", { mimeType: "application/pdf" })])).rejects.toMatchObject({ status: 400 });
    expect(await db.receipt.count()).toBe(0);
  });

  it("refuses the whole batch when one row is bad, importing nothing and naming the row", async () => {
    actAs(FINANCE);
    const batch = [importRow("g1"), importRow("g2", { retailer: "" }), importRow("g3")];
    await expect(importReceipts(batch)).rejects.toMatchObject({
      status: 400,
      message: "Import refused; nothing was imported. row 2 (g2): retailer: The retailer is required",
    });
    expect(await db.receipt.count()).toBe(0);
  });

  it("inserts a batch's receipts in one transaction, so a failed insert leaves none of them", async () => {
    const receipt = (n: number, afterInsert?: () => Promise<unknown>) => ({
      orgId: TEST_ORG_ID,
      actor: FINANCE,
      file: textFile(`together ${n}`),
      mimeType: "text/plain",
      core: { intakeSource: "import" },
      detail: { retailer: `Store ${n}`, receiptDate: "2023-03-01", receiptTotalCents: 500, state: "uploaded" },
      lines: [{ description: "Old thing", quantity: 1, unitPriceCents: 500 }],
      auditAction: "imported",
      afterInsert,
    });
    const failing = async () => {
      throw new Error("disk full");
    };
    await expect(insertReceiptsTogether([receipt(1), receipt(2), receipt(3, failing)], 30_000)).rejects.toThrow("disk full");
    expect(await db.receipt.count()).toBe(0);
    expect(await insertReceiptsTogether([receipt(4), receipt(5)], 30_000)).toHaveLength(2);
    expect(await db.receipt.count()).toBe(2);
  });

  it("imports the new rows of a batch and skips those already loaded", async () => {
    actAs(FINANCE);
    await importReceipts([importRow("s1")]);
    const res = await importReceipts([importRow("s1"), importRow("s2")]);
    expect(res).toMatchObject({ processed: 1, skipped: 1 });
    expect(res.results.map((x) => [x.importSourceId, x.status])).toEqual([["s1", "skipped"], ["s2", "processed"]]);
  });

  it("runs the pipeline on a re-run for a loaded row a failed run left in uploaded", async () => {
    actAs(FINANCE);
    const first = await importReceipts([importRow("p1")]);
    const [{ id }] = first.results;
    if (!id) throw new Error("the import returned no receipt id");
    await db.receiptDetail.update({ where: { id }, data: { state: "uploaded" } });
    await db.receipt.update({ where: { id }, data: { pushedAt: null } });
    const again = await importReceipts([importRow("p1")]);
    expect(again.results).toEqual([expect.objectContaining({ importSourceId: "p1", status: "processed", id, state: "receipt_finalized" })]);
  });

  it("refuses a row with no date", async () => {
    actAs(FINANCE);
    const dateless: Record<string, unknown> = importRow("d1");
    delete dateless.receiptDate;
    await expect(importReceipts([importRow("d0"), dateless])).rejects.toMatchObject({
      status: 400,
      message: "Import refused; nothing was imported. row 2 (d1): receiptDate: The date is required",
    });
    expect(await db.receipt.count()).toBe(0);
  });

  it("rejects a batch that claims reimbursement", async () => {
    actAs(FINANCE);
    for (const over of [{ needsReimbursement: true }, { reimbursementFor: "Someone" }]) {
      await expect(importReceipts([importRow("r1", over)])).rejects.toMatchObject({ status: 400 });
    }
    expect(await db.receipt.count()).toBe(0);
  });
});
