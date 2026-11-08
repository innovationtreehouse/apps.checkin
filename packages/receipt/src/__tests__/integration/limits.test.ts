import type { FailureReport } from "@checkin/component-kit";
import { beforeEach, expect, it, vi } from "vitest";
import { db } from "../../db";
import { receiptRepo } from "../../repositories/receipt";
import { receiptService } from "../../services/receiptService";
import type { ReceiptLimits } from "../../lib/limits";
import { OCR_FILE_REFUSED } from "../../contract";
import { describeDb } from "../helpers/db";
import { ALICE, BOB, TEST_ORG_ID, actAs, actions, clearAll, configure, failingOcr, manualDetails, okOcr, recordingPorts, stateOf, textFile } from "../helpers/setup";

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
    await expect(manual()).rejects.toMatchObject({ status: 429 });
    expect(await db.receipt.count()).toBe(2);
    actAs(BOB);
    await manual();
  });

  it("refuses a person's upload past the daily byte total", async () => {
    withLimits({ uploadBytesPerPersonPerDay: 2500 });
    await receiptService.upload(sized(1000), "text/plain", { details: manualDetails({ retailer: "A" }) });
    await receiptService.upload(sized(1000), "text/plain", { details: manualDetails({ retailer: "B" }) });
    await expect(receiptService.upload(sized(1000), "text/plain", { details: manualDetails({ retailer: "C" }) })).rejects.toMatchObject({
      status: 429,
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
      status: 429,
    });
    actAs(ALICE);
    await expect(receiptService.upload(sized(1000), "text/plain", { details: manualDetails({ retailer: "D" }) })).rejects.toMatchObject({
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
  it("counts every model call, retries included, and refuses past the daily limit", async () => {
    configure({ receiptSink: recordingPorts().receiptSink, ocr: failingOcr("data"), limits: { ...LOOSE, ocrCallsPerPersonPerDay: 2 } });
    const failed = await receiptService.upload(textFile(), "text/plain", {});
    expect(failed.state).toBe("ocr_failed");
    await receiptService.retryOcr(failed.id, "submitter");
    await expect(receiptService.retryOcr(failed.id, "submitter")).rejects.toMatchObject({ status: 429 });
    expect(await stateOf(failed.id)).toBe("ocr_failed");
    await expect(receiptService.upload(textFile(), "text/plain", {})).rejects.toMatchObject({ status: 429 });
    expect(await db.receiptAuditLog.count({ where: { userId: ALICE.id, action: "ocr_call" } })).toBe(2);
  });

  it("is kept in the database, so a fresh runtime sees the same count", async () => {
    configure({ receiptSink: recordingPorts().receiptSink, ocr: okOcr(), limits: { ...LOOSE, ocrCallsPerPersonPerDay: 1 } });
    await receiptService.upload(textFile(), "text/plain", {});
    configure({ receiptSink: recordingPorts().receiptSink, ocr: okOcr(), limits: { ...LOOSE, ocrCallsPerPersonPerDay: 1 } });
    await expect(receiptService.upload(textFile(), "text/plain", {})).rejects.toMatchObject({ status: 429 });
  });

  it("gives back the call of a missing setup every time", async () => {
    const kind = "settings";
    configure({ receiptSink: recordingPorts().receiptSink, ocr: failingOcr(kind), limits: { ...LOOSE, ocrCallsPerPersonPerDay: 1 } });
    const r = await receiptService.upload(textFile(), "text/plain", {});
    expect(r.state).toBe("ocr_failed");
    await receiptService.retryOcr(r.id, "submitter");
    await receiptService.retryOcr(r.id, "submitter");
    expect(await db.receiptAuditLog.count({ where: { userId: ALICE.id, action: "ocr_call_refunded", receiptId: r.id } })).toBe(3);
  });

  it.each(["system", "connection", "bug"] as const)("gives back a %s failure's call once per receipt; its retries count again", async (kind) => {
    configure({ receiptSink: recordingPorts().receiptSink, ocr: failingOcr(kind), limits: { ...LOOSE, ocrCallsPerPersonPerDay: 1 } });
    const r = await receiptService.upload(textFile(), "text/plain", {});
    expect(r.validationNotes).toMatch(/didn't count against/);
    const retried = await receiptService.retryOcr(r.id, "submitter");
    expect(retried.validationNotes).not.toMatch(/didn't count against/);
    await expect(receiptService.retryOcr(r.id, "submitter")).rejects.toMatchObject({ status: 429 });
    expect(await db.receiptAuditLog.count({ where: { action: "ocr_call_refunded" } })).toBe(1);
  });

  it.each([
    ["bug", true],
    ["settings", true],
    ["connection", true],
    ["system", true],
    ["data", false],
  ] as const)("reports a %s failure to the on-failure port: %s", async (kind, reported) => {
    const failures: FailureReport[] = [];
    vi.spyOn(console, "warn").mockImplementation(() => {});
    configure({ receiptSink: recordingPorts().receiptSink, ocr: failingOcr(kind), onFailure: (f) => void failures.push(f), limits: LOOSE });
    const r = await receiptService.upload(textFile(), "text/plain", {});
    expect(failures).toEqual(reported ? [{ lane: "ocr", kind, detail: `receipt ${r.id}` }] : []);
  });

  it("gives back the call when the upload it was reserved for is refused", async () => {
    withLimits({ uploadsPerPersonPerDay: 1, ocrCallsPerPersonPerDay: 1 });
    await manual();
    await expect(receiptService.upload(textFile(), "text/plain", {})).rejects.toMatchObject({ status: 429 });
    withLimits({ ocrCallsPerPersonPerDay: 1 });
    await receiptService.upload(textFile(), "text/plain", {});
  });

  it("gives back the call of a retry that lost the race to another", async () => {
    configure({ receiptSink: recordingPorts().receiptSink, ocr: failingOcr("data"), limits: { ...LOOSE, ocrCallsPerPersonPerDay: 2 } });
    const r = await receiptService.upload(textFile(), "text/plain", {});
    const seen = await receiptRepo.find(r.id, TEST_ORG_ID);
    // Another retry moves the receipt after this one has read it.
    await db.receiptDetail.update({ where: { id: r.id }, data: { state: "auto_upload" } });
    vi.spyOn(receiptRepo, "find").mockResolvedValueOnce(seen);
    await expect(receiptService.retryOcr(r.id, "submitter")).rejects.toBeDefined();
    expect(await db.receiptAuditLog.count({ where: { action: "ocr_call_refunded", receiptId: r.id } })).toBe(1);
  });

  it("gives back one call per receipt across the once-per-receipt kinds", async () => {
    configure({ receiptSink: recordingPorts().receiptSink, ocr: failingOcr("system"), limits: { ...LOOSE, ocrCallsPerPersonPerDay: 1 } });
    const r = await receiptService.upload(textFile(), "text/plain", {});
    configure({ receiptSink: recordingPorts().receiptSink, ocr: failingOcr("bug"), limits: { ...LOOSE, ocrCallsPerPersonPerDay: 1 } });
    await receiptService.retryOcr(r.id, "submitter");
    await expect(receiptService.retryOcr(r.id, "submitter")).rejects.toMatchObject({ status: 429 });
  });

  it("keeps the call a data failure spent", async () => {
    configure({ receiptSink: recordingPorts().receiptSink, ocr: failingOcr("data"), limits: { ...LOOSE, ocrCallsPerPersonPerDay: 1 } });
    const r = await receiptService.upload(textFile(), "text/plain", {});
    await expect(receiptService.retryOcr(r.id, "submitter")).rejects.toMatchObject({ status: 429 });
    expect(await db.receiptAuditLog.count({ where: { action: "ocr_call_refunded" } })).toBe(0);
  });

  it("gives back no call once the refunded call has left the window", async () => {
    configure({ receiptSink: recordingPorts().receiptSink, ocr: failingOcr("system"), limits: { ...LOOSE, ocrCallsPerPersonPerDay: 1 } });
    await receiptService.upload(textFile(), "text/plain", {});
    await db.receiptAuditLog.updateMany({ where: { action: "ocr_call" }, data: { changedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) } });
    configure({ receiptSink: recordingPorts().receiptSink, ocr: okOcr(), limits: { ...LOOSE, ocrCallsPerPersonPerDay: 1 } });
    await receiptService.upload(textFile(), "text/plain", {});
    await expect(receiptService.upload(textFile(), "text/plain", {})).rejects.toMatchObject({ status: 429 });
  });

  it("manual uploads spend no OCR calls", async () => {
    withLimits({ ocrCallsPerPersonPerDay: 1 });
    await manual();
    await manual();
    await receiptService.upload(textFile(), "text/plain", {});
  });
});

describeDb("a run of files the reading service refused", () => {
  const refusing = (failures: FailureReport[]) =>
    configure({ receiptSink: recordingPorts().receiptSink, ocr: failingOcr("data", OCR_FILE_REFUSED), onFailure: (f) => void failures.push(f), limits: LOOSE });
  const refused = () => receiptService.upload(textFile(), "text/plain", {});

  it("charges and keeps quiet about three different receipts, then reports and refunds the next as ours", async () => {
    const failures: FailureReport[] = [];
    vi.spyOn(console, "warn").mockImplementation(() => {});
    refusing(failures);
    const first = [await refused(), await refused()];
    actAs(BOB);
    first.push(await refused());
    for (const r of first) expect(await actions(r.id)).toContain("ocr_failed:data");
    expect(failures).toEqual([]);
    expect(await db.receiptAuditLog.count({ where: { action: "ocr_call_refunded" } })).toBe(0);

    const next = await refused();
    expect(next.validationNotes).toMatch(/until an administrator reconnects it: the reading service refused several receipts in a row/);
    expect(await actions(next.id)).toEqual(expect.arrayContaining(["ocr_failed:connection", "ocr_call_refunded"]));
    expect(failures).toEqual([{ lane: "ocr", kind: "connection", detail: `receipt ${next.id}` }]);

    const after = await refused();
    expect(await actions(after.id)).toContain("ocr_failed:connection");
  });

  it("keeps one submitter's run of refused files as theirs", async () => {
    const failures: FailureReport[] = [];
    refusing(failures);
    for (let i = 0; i < 4; i++) expect(await actions((await refused()).id)).toContain("ocr_failed:data");
    expect(failures).toEqual([]);
  });

  it("ends the run at a successful reading", async () => {
    refusing([]);
    await refused();
    actAs(BOB);
    await refused();
    await refused();
    configure({ receiptSink: recordingPorts().receiptSink, ocr: okOcr(), limits: LOOSE });
    await receiptService.upload(textFile(), "text/plain", {});
    refusing([]);
    expect(await actions((await refused()).id)).toContain("ocr_failed:data");
  });

  it("counts one receipt refused again on retry once", async () => {
    refusing([]);
    const r = await refused();
    await receiptService.retryOcr(r.id, "submitter");
    await receiptService.retryOcr(r.id, "submitter");
    actAs(BOB);
    await refused();
    expect(await actions((await refused()).id)).toContain("ocr_failed:data");
  });

  it("does not count other unreadable files, or refusals older than the window", async () => {
    configure({ receiptSink: recordingPorts().receiptSink, ocr: failingOcr("data", "no line items were found"), limits: LOOSE });
    await refused();
    await refused();
    await refused();
    refusing([]);
    const old = [await refused(), await refused()];
    await db.receiptAuditLog.updateMany({ where: { receiptId: { in: old.map((r) => r.id) } }, data: { changedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) } });
    actAs(BOB);
    await refused();
    expect(await actions((await refused()).id)).toContain("ocr_failed:data");
  });
});
