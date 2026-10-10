import { beforeEach, expect, it } from "vitest";
import { db } from "../../db";
import { repushUnpushed, sweepInterruptedOcr } from "../../services/catchUp";
import { importReceipts } from "../../services/importService";
import { receiptService } from "../../services/receiptService";
import { describeDb } from "../helpers/db";
import { FINANCE, actAs, clearAll, configure, manualDetails, recordingPorts, stateOf, textFile } from "../helpers/setup";

let ports: ReturnType<typeof recordingPorts>;

beforeEach(async () => {
  await clearAll();
  ports = recordingPorts();
  configure({ receiptSink: ports.receiptSink });
});

describeDb("catch-up steps", () => {
  it("re-pushes finalized receipts whose push failed, and counts only", async () => {
    ports.fail.push = true;
    const r = await receiptService.upload(textFile(), "text/plain", { details: manualDetails() });
    ports.fail.push = false;
    expect(await repushUnpushed()).toEqual({ pushed: 1, failed: 0 });
    expect((await db.receipt.findUniqueOrThrow({ where: { id: r.id } })).pushedAt).not.toBeNull();
    expect(await repushUnpushed()).toEqual({ pushed: 0, failed: 0 });
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
  needsReimbursement: true,
  reimbursementFor: "Someone",
  mimeType: "text/plain",
  fileBase64: Buffer.from(`historical ${importSourceId}`).toString("base64"),
  lineItems: [{ lineNumber: 1, description: "Old thing", quantity: 1, unitPriceCents: 500, totalPriceCents: 500, isDelayed: false }],
  ...over,
});

describeDb("historical import", () => {
  it("runs the pipeline, waives submitter and age steps, pushes as backfill, and skips on re-run", async () => {
    actAs(FINANCE);
    const first = await importReceipts([importRow("u1")]);
    expect(first).toMatchObject({ processed: 1, skipped: 0, errors: 0, byState: { receipt_finalized: 1 } });
    expect(ports.calls.pushes[0]).toMatchObject({ backfill: true, needsReimbursement: true });
    expect(ports.calls.pushes[0].reimburseePersonId).toBeUndefined();

    const again = await importReceipts([importRow("u1")]);
    expect(again).toMatchObject({ processed: 0, skipped: 1 });
  });

  it("caps a batch at 50 and checks each file's bytes", async () => {
    actAs(FINANCE);
    await expect(importReceipts(Array.from({ length: 51 }, (_, i) => importRow(`b${i}`)))).rejects.toMatchObject({ statusCode: 400 });
    const res = await importReceipts([importRow("bad", { mimeType: "application/pdf" })]);
    expect(res).toMatchObject({ errors: 1, processed: 0 });
  });
});
