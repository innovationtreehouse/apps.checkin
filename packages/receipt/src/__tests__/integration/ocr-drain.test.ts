import { beforeEach, expect, it, vi } from "vitest";
import { db } from "../../db";
import { drainOcrQueue, DRAIN_CAP } from "../../services/ocrDrain";
import { mailRunState, takeInMailbox } from "../../services/mailIntake";
import { intakeMailedReceipt, readQueued } from "../../services/receiptService";
import type { OcrProvider } from "../../contract";
import { describeDb } from "../helpers/db";
import { ALICE, BOB, clearAll, configure, okOcr, recordingPorts, stateOf } from "../helpers/setup";

const LIMITS = {
  uploadsPerPersonPerDay: 100,
  mailUploadsPerPersonPerDay: 100,
  mailUploadsPerRaisedPersonPerDay: 100,
  uploadBytesPerPersonPerDay: 10 * 1024 * 1024,
  uploadBytesPerDay: 10 * 1024 * 1024,
  ocrCallsPerPersonPerDay: 100,
};

const order: string[] = [];
const recordingOcr = (): OcrProvider => ({
  extract: async (file, ...rest) => {
    order.push(file.toString());
    return okOcr({ retailer: `Store ${order.length}` }).extract(file, ...rest);
  },
});

const queue = async (label: string, sender = ALICE, queuedAt = new Date()) => {
  const id = await intakeMailedReceipt(sender, Buffer.from(label), "text/plain", async () => undefined);
  await db.receiptDetail.update({ where: { id }, data: { ocrQueuedAt: queuedAt } });
  return id;
};

const later = () => Date.now() + 60_000;

beforeEach(async () => {
  await clearAll();
  order.length = 0;
  configure({ receiptSink: recordingPorts().receiptSink, ocr: recordingOcr(), limits: LIMITS });
});

describeDb("the reading drain", () => {
  it("reads waiting receipts oldest first, each charged to its uploader", async () => {
    const t = Date.now();
    await queue("receipt newer one with enough text to read", ALICE, new Date(t - 1_000));
    await queue("receipt older one with enough text to read", BOB, new Date(t - 60_000));
    expect(await drainOcrQueue(later())).toEqual({ read: 2, failed: 0, waiting: 0 });
    expect(order).toEqual(["receipt older one with enough text to read", "receipt newer one with enough text to read"]);
    expect(await db.receiptAuditLog.count({ where: { action: "ocr_call", userId: BOB.id } })).toBe(1);
    expect(await db.receiptAuditLog.count({ where: { action: "ocr_call", userId: ALICE.id } })).toBe(1);
  });

  it("stops at its cap; the rest wait for the next run", async () => {
    for (let i = 0; i <= DRAIN_CAP; i++) await queue(`receipt number ${i} with enough text to be read`);
    expect(await drainOcrQueue(later())).toEqual({ read: DRAIN_CAP, failed: 0, waiting: 1 });
  });

  it("stops at its deadline", async () => {
    await queue("receipt waiting past the deadline of the drain");
    expect(await drainOcrQueue(Date.now() - 1)).toEqual({ read: 0, failed: 0, waiting: 1 });
  });

  it("skips a receipt another reader claimed first", async () => {
    const claimed = await queue("receipt the upload reader already took");
    const waiting = await queue("receipt only the drain will read now");
    expect(await readQueued(claimed, ALICE)).toBe(true);
    expect(await drainOcrQueue(later())).toEqual({ read: 1, failed: 0, waiting: 0 });
    expect(order).toEqual(["receipt the upload reader already took", "receipt only the drain will read now"]);
    expect(await stateOf(waiting)).toBe("submitter_review");
  });

  it("over the uploader's allowance, lands the receipt in ocr_failed with the allowance note", async () => {
    configure({ receiptSink: recordingPorts().receiptSink, ocr: recordingOcr(), limits: { ...LIMITS, ocrCallsPerPersonPerDay: 1 } });
    await queue("receipt read within the daily allowance", ALICE, new Date(Date.now() - 1_000));
    const over = await queue("receipt over the daily allowance");
    expect(await drainOcrQueue(later())).toEqual({ read: 2, failed: 0, waiting: 0 });
    expect(await db.receiptDetail.findUnique({ where: { id: over } })).toMatchObject({ state: "ocr_failed", validationNotes: expect.stringMatching(/allowance is used up/) });
  });

  it("runs from the daily step with no mailbox bound, under the mail lease", async () => {
    const id = await queue("receipt waiting where no mailbox is bound");
    expect(await takeInMailbox()).toEqual({ status: "unbound" });
    await vi.waitFor(async () => expect(await stateOf(id)).toBe("submitter_review"), { timeout: 10_000 });
    await vi.waitFor(async () => expect((await mailRunState()).running).toBe(false), { timeout: 10_000 });
  });
});
