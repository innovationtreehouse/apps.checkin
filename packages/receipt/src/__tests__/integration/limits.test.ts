import { beforeEach, expect, it } from "vitest";
import { db } from "../../db";
import { readQueued, receiptService } from "../../services/receiptService";
import type { ReceiptLimits } from "../../lib/limits";
import { describeDb } from "../helpers/db";
import { ALICE, BOB, actAs, clearAll, configure, failingOcr, manualDetails, okOcr, recordingPorts, stateOf, textFile, uploadRead, retryRead } from "../helpers/setup";

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

const manual = () => uploadRead(textFile(), "text/plain", { details: manualDetails() });
const sized = (bytes: number) => Buffer.from(`${"x".repeat(bytes - 12)}${String(Date.now() % 1e12).padStart(12, "0")}`);

beforeEach(async () => {
  await clearAll();
});

describeDb("upload limits", () => {
  it("refuses a person's upload past the daily count; manual uploads count", async () => {
    withLimits({ uploadsPerPersonPerDay: 2 });
    await manual();
    await manual();
    await expect(manual()).rejects.toMatchObject({ status: 429 });
    expect(await db.receipt.count()).toBe(2);
    actAs(BOB);
    await manual();
  });

  it("refuses a person's upload past the daily byte total", async () => {
    withLimits({ uploadBytesPerPersonPerDay: 2500 });
    await uploadRead(sized(1000), "text/plain", { details: manualDetails({ retailer: "A" }) });
    await uploadRead(sized(1000), "text/plain", { details: manualDetails({ retailer: "B" }) });
    await expect(uploadRead(sized(1000), "text/plain", { details: manualDetails({ retailer: "C" }) })).rejects.toMatchObject({
      status: 429,
    });
    actAs(BOB);
    await uploadRead(sized(1000), "text/plain", { details: manualDetails({ retailer: "D" }) });
  });

  it("refuses anyone's upload past the org's daily byte budget", async () => {
    withLimits({ uploadBytesPerDay: 2500 });
    await uploadRead(sized(1000), "text/plain", { details: manualDetails({ retailer: "A" }) });
    actAs(BOB);
    await uploadRead(sized(1000), "text/plain", { details: manualDetails({ retailer: "B" }) });
    await expect(uploadRead(sized(1000), "text/plain", { details: manualDetails({ retailer: "C" }) })).rejects.toMatchObject({
      status: 429,
    });
    actAs(ALICE);
    await expect(uploadRead(sized(1000), "text/plain", { details: manualDetails({ retailer: "D" }) })).rejects.toMatchObject({
      status: 429,
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
  const ALLOWANCE_NOTE = /allowance is used up/;

  it("counts every model call, retries included; past the daily limit a reading lands in ocr_failed with the allowance note", async () => {
    configure({ receiptSink: recordingPorts().receiptSink, ocr: failingOcr("data"), limits: { ...LOOSE, ocrCallsPerPersonPerDay: 2 } });
    const failed = await uploadRead(textFile(), "text/plain", {});
    expect(failed.state).toBe("ocr_failed");
    await retryRead(failed.id, "submitter");
    await retryRead(failed.id, "submitter");
    expect(await stateOf(failed.id)).toBe("ocr_failed");
    expect((await receiptService.get(failed.id, "submitter")).validationNotes).toMatch(ALLOWANCE_NOTE);
    const over = await uploadRead(textFile(), "text/plain", {});
    expect(over).toMatchObject({ state: "ocr_failed", validationNotes: expect.stringMatching(ALLOWANCE_NOTE) });
    expect(await db.receiptAuditLog.count({ where: { userId: ALICE.id, action: "ocr_call" } })).toBe(2);
  });

  it("is kept in the database, so a fresh runtime sees the same count", async () => {
    configure({ receiptSink: recordingPorts().receiptSink, ocr: okOcr(), limits: { ...LOOSE, ocrCallsPerPersonPerDay: 1 } });
    await uploadRead(textFile(), "text/plain", {});
    configure({ receiptSink: recordingPorts().receiptSink, ocr: okOcr(), limits: { ...LOOSE, ocrCallsPerPersonPerDay: 1 } });
    expect((await uploadRead(textFile(), "text/plain", {})).validationNotes).toMatch(ALLOWANCE_NOTE);
  });

  it.each(["system", "connection", "settings", "data", "bug"] as const)("keeps the call a %s failure spent, and the note says nothing of the allowance", async (kind) => {
    configure({ receiptSink: recordingPorts().receiptSink, ocr: failingOcr(kind), limits: { ...LOOSE, ocrCallsPerPersonPerDay: 1 } });
    const r = await uploadRead(textFile(), "text/plain", {});
    expect(r.validationNotes).not.toMatch(/allowance/);
    await retryRead(r.id, "submitter");
    expect((await receiptService.get(r.id, "submitter")).validationNotes).toMatch(ALLOWANCE_NOTE);
  });

  it("spends no call on an upload the upload limits refuse, since nothing was saved to read", async () => {
    withLimits({ uploadsPerPersonPerDay: 1, ocrCallsPerPersonPerDay: 1 });
    await manual();
    await expect(uploadRead(textFile(), "text/plain", {})).rejects.toMatchObject({ status: 429 });
    expect(await db.receiptAuditLog.count({ where: { action: "ocr_call" } })).toBe(0);
  });

  it("spends one call when two readers race for one queued receipt", async () => {
    withLimits({ ocrCallsPerPersonPerDay: 5 });
    const r = await uploadRead(textFile(), "text/plain", { details: manualDetails() });
    await db.receiptDetail.update({ where: { id: r.id }, data: { state: "ocr_queued", ocrQueuedAt: new Date() } });
    const claims = await Promise.all([readQueued(r.id, ALICE), readQueued(r.id, ALICE)]);
    expect(claims.sort()).toEqual([false, true]);
    expect(await db.receiptAuditLog.count({ where: { action: "ocr_call", userId: ALICE.id } })).toBe(1);
  });

  it("manual uploads spend no OCR calls", async () => {
    withLimits({ ocrCallsPerPersonPerDay: 1 });
    await manual();
    await manual();
    await uploadRead(textFile(), "text/plain", {});
  });
});
