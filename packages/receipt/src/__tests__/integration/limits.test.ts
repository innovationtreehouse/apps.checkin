import { beforeEach, expect, it } from "vitest";
import { db } from "../../db";
import { receiptService } from "../../services/receiptService";
import type { ReceiptLimits } from "../../lib/limits";
import { describeDb } from "../helpers/db";
import { ALICE, BOB, actAs, clearAll, configure, manualDetails, okOcr, recordingPorts, stateOf, textFile } from "../helpers/setup";

const LOOSE: ReceiptLimits = {
  uploadsPerPersonPerDay: 100,
  mailUploadsPerPersonPerDay: 100,
  mailUploadsPerRaisedPersonPerDay: 100,
  uploadBytesPerPersonPerDay: 10 * 1024 * 1024,
  uploadBytesPerDay: 10 * 1024 * 1024,
  ocrCallsPerPersonPerDay: 100,
};

function withLimits(limits: Partial<ReceiptLimits>) {
  configure({ receiptSink: recordingPorts().receiptSink, ocr: okOcr(), limits: { ...LOOSE, ...limits } });
}

const manual = () => receiptService.upload(textFile(), "text/plain", { details: manualDetails() });
const sized = (bytes: number) => Buffer.from(`${"x".repeat(bytes - 12)}${String(Date.now() % 1e12).padStart(12, "0")}`);

beforeEach(async () => {
  await clearAll();
});

describeDb("upload limits", () => {
  it("refuses a person's upload past the daily count; manual uploads count", async () => {
    withLimits({ uploadsPerPersonPerDay: 2 });
    await manual();
    await manual();
    await expect(manual()).rejects.toMatchObject({ statusCode: 429 });
    expect(await db.receipt.count()).toBe(2);
    actAs(BOB);
    await manual();
  });

  it("refuses a person's upload past the daily byte total", async () => {
    withLimits({ uploadBytesPerPersonPerDay: 2500 });
    await receiptService.upload(sized(1000), "text/plain", { details: manualDetails({ retailer: "A" }) });
    await receiptService.upload(sized(1000), "text/plain", { details: manualDetails({ retailer: "B" }) });
    await expect(receiptService.upload(sized(1000), "text/plain", { details: manualDetails({ retailer: "C" }) })).rejects.toMatchObject({
      statusCode: 429,
    });
    actAs(BOB);
    await receiptService.upload(sized(1000), "text/plain", { details: manualDetails({ retailer: "D" }) });
  });

  it("refuses anyone's upload past the org's daily byte budget", async () => {
    withLimits({ uploadBytesPerDay: 2500 });
    await receiptService.upload(sized(1000), "text/plain", { details: manualDetails({ retailer: "A" }) });
    actAs(BOB);
    await receiptService.upload(sized(1000), "text/plain", { details: manualDetails({ retailer: "B" }) });
    await expect(receiptService.upload(sized(1000), "text/plain", { details: manualDetails({ retailer: "C" }) })).rejects.toMatchObject({
      statusCode: 429,
    });
    actAs(ALICE);
    await expect(receiptService.upload(sized(1000), "text/plain", { details: manualDetails({ retailer: "D" }) })).rejects.toMatchObject({
      statusCode: 429,
    });
  });

  it("counts uploads from before the window's start no more", async () => {
    withLimits({ uploadsPerPersonPerDay: 1 });
    const old = await manual();
    await db.receipt.update({ where: { id: old.id }, data: { uploadedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) } });
    await manual();
  });
});

describeDb("OCR call quota", () => {
  it("counts every model call, retries included, and refuses past the daily limit", async () => {
    configure({ receiptSink: recordingPorts().receiptSink, limits: { ...LOOSE, ocrCallsPerPersonPerDay: 2 } });
    const failed = await receiptService.upload(textFile(), "text/plain", {});
    expect(failed.state).toBe("ocr_failed");
    await receiptService.retryOcr(failed.id, "submitter");
    await expect(receiptService.retryOcr(failed.id, "submitter")).rejects.toMatchObject({ statusCode: 429 });
    expect(await stateOf(failed.id)).toBe("ocr_failed");
    await expect(receiptService.upload(textFile(), "text/plain", {})).rejects.toMatchObject({ statusCode: 429 });
    expect(await db.receiptAuditLog.count({ where: { userId: ALICE.id, action: "ocr_call" } })).toBe(2);
  });

  it("is kept in the database, so a fresh runtime sees the same count", async () => {
    configure({ receiptSink: recordingPorts().receiptSink, ocr: okOcr(), limits: { ...LOOSE, ocrCallsPerPersonPerDay: 1 } });
    await receiptService.upload(textFile(), "text/plain", {});
    configure({ receiptSink: recordingPorts().receiptSink, ocr: okOcr(), limits: { ...LOOSE, ocrCallsPerPersonPerDay: 1 } });
    await expect(receiptService.upload(textFile(), "text/plain", {})).rejects.toMatchObject({ statusCode: 429 });
  });

  it("manual uploads spend no OCR calls", async () => {
    withLimits({ ocrCallsPerPersonPerDay: 1 });
    await manual();
    await manual();
    await receiptService.upload(textFile(), "text/plain", {});
  });
});
