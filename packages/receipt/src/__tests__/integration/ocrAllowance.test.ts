import { beforeEach, expect, it } from "vitest";
import { db } from "../../db";
import { receiptService } from "../../services/receiptService";
import type { ReceiptLimits } from "../../lib/limits";
import { describeDb } from "../helpers/db";
import { ALICE, BOB, FINANCE, actAs, clearAll, configure, failingOcr, okOcr, recordingPorts, textFile } from "../helpers/setup";

const ONE_A_DAY: ReceiptLimits = {
  uploadsPerPersonPerDay: 100,
  mailUploadsPerPersonPerDay: 100,
  mailUploadsPerRaisedPersonPerDay: 100,
  uploadBytesPerPersonPerDay: 10 * 1024 * 1024,
  uploadBytesPerDay: 10 * 1024 * 1024,
  ocrCallsPerPersonPerDay: 1,
};

const read = () => receiptService.upload(textFile(), "text/plain", {});

async function reset(personId: number, reason = "a batch of conference receipts") {
  actAs(FINANCE);
  const result = await receiptService.resetOcrAllowance(personId, { reason });
  actAs(ALICE);
  return result;
}

beforeEach(async () => {
  await clearAll();
  configure({ receiptSink: recordingPorts().receiptSink, ocr: okOcr(), limits: ONE_A_DAY });
});

describeDb("resetting a person's reading allowance", () => {
  it("lets the person read again once their allowance is used up", async () => {
    await read();
    await expect(read()).rejects.toMatchObject({ status: 429 });
    expect(await reset(ALICE.id)).toEqual({ personId: ALICE.id });
    await read();
  });

  it("counts every call from the reset on, so the allowance runs out again", async () => {
    await read();
    await reset(ALICE.id);
    await read();
    await expect(read()).rejects.toMatchObject({ status: 429 });
  });

  it("counts a failed reading after the reset", async () => {
    configure({ receiptSink: recordingPorts().receiptSink, ocr: failingOcr("data"), limits: ONE_A_DAY });
    const failed = await read();
    await reset(ALICE.id);
    await receiptService.retryOcr(failed.id, "submitter");
    await expect(receiptService.retryOcr(failed.id, "submitter")).rejects.toMatchObject({ status: 429 });
  });

  it("resets only the named person", async () => {
    await read();
    actAs(BOB);
    await read();
    await reset(ALICE.id);
    actAs(BOB);
    await expect(read()).rejects.toMatchObject({ status: 429 });
  });

  it("writes one audit row naming the person, the actor and the reason", async () => {
    await reset(ALICE.id, "re-sent statements");
    expect(await db.receiptAuditLog.findMany({ where: { action: "ocr_allowance_reset" } })).toEqual([
      expect.objectContaining({ receiptId: null, userId: FINANCE.id, username: FINANCE.name, fieldChanged: "person", valueBefore: String(ALICE.id), valueAfter: "re-sent statements" }),
    ]);
  });

  it("needs a reason", async () => {
    actAs(FINANCE);
    await expect(receiptService.resetOcrAllowance(ALICE.id, { reason: "  " })).rejects.toMatchObject({ status: 400 });
    await expect(receiptService.resetOcrAllowance(ALICE.id, {})).rejects.toMatchObject({ status: 400 });
    expect(await db.receiptAuditLog.count({ where: { action: "ocr_allowance_reset" } })).toBe(0);
  });

  it("no longer matters once the window has passed it", async () => {
    await read();
    await reset(ALICE.id);
    await db.receiptAuditLog.updateMany({ where: { action: "ocr_allowance_reset" }, data: { changedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) } });
    await expect(read()).rejects.toMatchObject({ status: 429 });
  });
});
