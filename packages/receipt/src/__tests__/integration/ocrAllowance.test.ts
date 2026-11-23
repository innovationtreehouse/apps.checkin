import { beforeEach, expect, it } from "vitest";
import { db } from "../../db";
import { receiptService } from "../../services/receiptService";
import type { ReceiptLimits } from "../../lib/limits";
import { inertReimbursees } from "../../runtime";
import { describeDb } from "../helpers/db";
import { ALICE, BOB, FINANCE, actAs, clearAll, configure, failingOcr, okOcr, recordingPorts, textFile, uploadRead, retryRead } from "../helpers/setup";

const ONE_A_DAY: ReceiptLimits = {
  uploadsPerPersonPerDay: 100,
  mailUploadsPerPersonPerDay: 100,
  mailUploadsPerRaisedPersonPerDay: 100,
  uploadBytesPerPersonPerDay: 10 * 1024 * 1024,
  uploadBytesPerDay: 10 * 1024 * 1024,
  ocrCallsPerPersonPerDay: 1,
};

const known = new Set([ALICE.id, BOB.id]);
const people = { ...inertReimbursees, byId: async (id: number) => (known.has(id) ? { id, name: "Someone", isAdult: true } : null) };

const read = () => uploadRead(textFile(), "text/plain", {});
/** An upload over the allowance is saved, and lands in ocr_failed with the allowance note. */
const readOverAllowance = async () => expect((await read()).validationNotes).toMatch(/allowance is used up/);

async function reset(personId: number, reason = "a batch of conference receipts") {
  actAs(FINANCE);
  const result = await receiptService.resetOcrAllowance(personId, { reason });
  actAs(ALICE);
  return result;
}

beforeEach(async () => {
  await clearAll();
  configure({ receiptSink: recordingPorts().receiptSink, ocr: okOcr(), limits: ONE_A_DAY, reimbursees: people });
});

describeDb("resetting a person's reading allowance", () => {
  it("lets the person read again once their allowance is used up", async () => {
    await read();
    await readOverAllowance();
    expect(await reset(ALICE.id)).toEqual({ personId: ALICE.id });
    await read();
  });

  it("counts every call from the reset on, so the allowance runs out again", async () => {
    await read();
    await reset(ALICE.id);
    await read();
    await readOverAllowance();
  });

  it("counts a failed reading after the reset", async () => {
    configure({ receiptSink: recordingPorts().receiptSink, ocr: failingOcr("data"), limits: ONE_A_DAY, reimbursees: people });
    const failed = await read();
    await reset(ALICE.id);
    await retryRead(failed.id, "submitter");
    await retryRead(failed.id, "submitter");
    expect((await receiptService.get(failed.id, "submitter")).validationNotes).toMatch(/allowance is used up/);
  });

  it("resets only the named person", async () => {
    await read();
    actAs(BOB);
    await read();
    await reset(ALICE.id);
    actAs(BOB);
    await readOverAllowance();
  });

  it("writes one audit row naming the person, the actor and the reason", async () => {
    await reset(ALICE.id, "re-sent statements");
    expect(await db.receiptAuditLog.findMany({ where: { action: "ocr_allowance_reset" } })).toEqual([
      expect.objectContaining({ receiptId: null, userId: FINANCE.id, username: FINANCE.name, fieldChanged: "person", valueBefore: String(ALICE.id), valueAfter: "re-sent statements" }),
    ]);
  });

  it("refuses a person who does not exist, writing nothing", async () => {
    await expect(reset(999_999)).rejects.toMatchObject({ status: 404 });
    expect(await db.receiptAuditLog.count({ where: { action: "ocr_allowance_reset" } })).toBe(0);
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
    await readOverAllowance();
  });
});
