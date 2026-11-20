import { beforeEach, expect, it, vi } from "vitest";
import { db } from "../../db";
import type { OutcomeNotice } from "../../contract";
import { oweOutcomeNotice, retryOutcomeNotice, SEND_FAILED_AGAIN, sweepOutcomeNotices } from "../../services/outcomeNotices";
import { receiptService } from "../../services/receiptService";
import { retryStuckItem, stuckItems } from "../../stuckItems";
import { describeDb } from "../helpers/db";
import { ALICE, BOB, FINANCE, TEST_ORG_ID, actAs, clearAll, configure, manualDetails, recordingPorts, stateOf, textFile, uploadRead } from "../helpers/setup";

vi.mock("../../services/outcomeNotices", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../services/outcomeNotices")>();
  return { ...real, oweOutcomeNotice: vi.fn(real.oweOutcomeNotice) };
});

type Sent = { notice: OutcomeNotice; to: "uploader" | "reimbursee" };

let sent: Sent[];
let failSends: boolean;

function setup(bound = true): void {
  configure({
    receiptSink: recordingPorts().receiptSink,
    outcomeMail: bound
      ? {
          send: async (notice, to) => {
            sent.push({ notice, to });
            return !failSends;
          },
        }
      : undefined,
  });
}

beforeEach(async () => {
  await clearAll();
  sent = [];
  failSends = false;
  setup();
});

/** ALICE's receipt, never pushed (its total disagrees with its lines), moved straight to `state`, reimbursing `reimburseePersonId` when given. */
async function aliceReceiptIn(state: string, reimburseePersonId: number | null = null): Promise<string> {
  actAs(ALICE);
  const r = await uploadRead(textFile(), "text/plain", { details: manualDetails({ retailer: "Acme Hardware", receiptDate: "2026-10-02", receiptTotal: "25.00" }) });
  await db.receiptDetail.update({ where: { id: r.id }, data: { state } });
  if (reimburseePersonId !== null) await db.receipt.update({ where: { id: r.id }, data: { needsReimbursement: true, reimburseePersonId } });
  return r.id;
}

const notices = (receiptId: string) => db.receiptOutcomeNotice.findMany({ where: { receiptId } });

describeDb("receipt outcome notices", () => {
  it("owes one notice when finance rejects, and emails the uploader right after", async () => {
    const id = await aliceReceiptIn("financial_review");
    actAs(FINANCE);
    await receiptService.rejectFinancial(id, "not a club purchase");

    expect(await notices(id)).toEqual([expect.objectContaining({ orgId: TEST_ORG_ID, event: "receipt_rejected", uploaderSentAt: expect.any(Date), reimburseeSentAt: null, doneAt: expect.any(Date) })]);
    expect(sent).toEqual([
      { to: "uploader", notice: { receiptId: id, outcome: "receipt_rejected", uploaderPersonId: ALICE.id, reimburseePersonId: null, retailer: "Acme Hardware", receiptDate: "2026-10-02" } },
    ]);
  });

  it("emails the person reimbursed separately when that is someone else", async () => {
    const id = await aliceReceiptIn("submitter_review", BOB.id);
    actAs(FINANCE);
    await receiptService.rejectFinancial(id, "personal purchase");

    expect(sent.map((s) => s.to)).toEqual(["uploader", "reimbursee"]);
    expect(await notices(id)).toEqual([expect.objectContaining({ uploaderSentAt: expect.any(Date), reimburseeSentAt: expect.any(Date), doneAt: expect.any(Date) })]);
  });

  it("sends one copy when the uploader is the person reimbursed", async () => {
    const id = await aliceReceiptIn("submitter_review", ALICE.id);
    actAs(FINANCE);
    await receiptService.rejectFinancial(id, "personal purchase");
    expect(sent.map((s) => s.to)).toEqual(["uploader"]);
  });

  it("owes a notice for each copy Keep this one rejects", async () => {
    const file = textFile();
    actAs(ALICE);
    const a = await uploadRead(file, "text/plain", {});
    const b = await uploadRead(file, "text/plain", { details: manualDetails() });
    actAs(FINANCE);
    await receiptService.keepThisOne(b.id, [a.id, b.id]);

    expect(await stateOf(a.id)).toBe("rejected");
    expect(await notices(a.id)).toHaveLength(1);
    expect(await notices(b.id)).toHaveLength(0);
    expect(sent.map((s) => s.notice.receiptId)).toEqual([a.id]);
  });

  it("owes nothing for any other ending: a discard, an approval, a finalized receipt", async () => {
    const discarded = await aliceReceiptIn("submitter_review");
    await receiptService.discard(discarded, "submitter");
    const approved = await aliceReceiptIn("financial_review");
    actAs(FINANCE);
    await receiptService.approveFinancial(approved);
    actAs(ALICE);
    const finalized = await uploadRead(textFile(), "text/plain", { details: manualDetails({ retailer: "Elsewhere" }) });

    expect(await stateOf(discarded)).toBe("discarded");
    expect(await stateOf(finalized.id)).toBe("receipt_finalized");
    expect(await db.receiptOutcomeNotice.count()).toBe(0);
    expect(sent).toEqual([]);
  });

  it("writes no second notice for a second reject or a replayed write", async () => {
    const id = await aliceReceiptIn("financial_review");
    actAs(FINANCE);
    await receiptService.rejectFinancial(id, "late");
    await expect(receiptService.rejectFinancial(id, "again")).rejects.toMatchObject({ status: 400 });
    await db.$transaction((tx) => oweOutcomeNotice(tx, TEST_ORG_ID, id, "receipt_rejected"));

    expect(await notices(id)).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it("commits the notice with the state change and rolls it back with it", async () => {
    const id = await aliceReceiptIn("financial_review");
    const real = await vi.importActual<typeof import("../../services/outcomeNotices")>("../../services/outcomeNotices");
    vi.mocked(oweOutcomeNotice).mockImplementationOnce(async (...args) => {
      await real.oweOutcomeNotice(...args);
      expect(await args[0].receiptOutcomeNotice.count({ where: { receiptId: id } })).toBe(1);
      throw new Error("crash before commit");
    });
    actAs(FINANCE);
    await expect(receiptService.rejectFinancial(id, "late")).rejects.toThrow("crash before commit");
    expect(await stateOf(id)).toBe("financial_review");
    expect(await notices(id)).toHaveLength(0);
    expect(sent).toEqual([]);

    await receiptService.rejectFinancial(id, "late");
    expect(await stateOf(id)).toBe("rejected");
    expect(await notices(id)).toHaveLength(1);
  });

  it("keeps the notice owed while the host's mail out is unbound, and the sweep sends it once bound", async () => {
    setup(false);
    const id = await aliceReceiptIn("financial_review", BOB.id);
    actAs(FINANCE);
    await receiptService.rejectFinancial(id, "late");
    expect(await sweepOutcomeNotices()).toEqual({ sent: 0, failed: 0 });
    expect(await notices(id)).toEqual([expect.objectContaining({ doneAt: null, firstFailedAt: null })]);

    setup();
    expect(await sweepOutcomeNotices()).toEqual({ sent: 2, failed: 0 });
    expect(await sweepOutcomeNotices()).toEqual({ sent: 0, failed: 0 });
    expect(sent.map((s) => s.to)).toEqual(["uploader", "reimbursee"]);
  });

  it("a failed copy leaves the notice stuck with its error; the sweep never retries it", async () => {
    const id = await aliceReceiptIn("financial_review", BOB.id);
    configure({
      receiptSink: recordingPorts().receiptSink,
      outcomeMail: { send: async (notice, to) => (sent.push({ notice, to }), to === "uploader") },
    });
    actAs(FINANCE);
    await receiptService.rejectFinancial(id, "late");
    const [row] = await notices(id);
    expect(row).toMatchObject({ reimburseeSentAt: null, claimedAt: null, doneAt: null, failureReason: "To the reimbursee: the mail out reported failure" });
    expect(row.uploaderSentAt).not.toBeNull();
    expect(row.firstFailedAt).not.toBeNull();

    setup();
    sent = [];
    expect(await sweepOutcomeNotices()).toEqual({ sent: 0, failed: 0 });
    expect(sent).toEqual([]);
    expect(await stuckItems()).toEqual([{ id: String(row.id), step: "outcome email", href: `/receipts/${id}`, failedAt: row.firstFailedAt }]);
  });

  it("a send that throws records its error text", async () => {
    const id = await aliceReceiptIn("financial_review");
    configure({
      receiptSink: recordingPorts().receiptSink,
      outcomeMail: {
        send: async () => {
          throw new Error("provider down");
        },
      },
    });
    actAs(FINANCE);
    await receiptService.rejectFinancial(id, "late");
    expect(await notices(id)).toEqual([expect.objectContaining({ doneAt: null, failureReason: "To the uploader: provider down" })]);
  });

  it("a person's Retry sends only the copy still owed, keeps the first failure time, and finishes the notice", async () => {
    const id = await aliceReceiptIn("financial_review", BOB.id);
    configure({
      receiptSink: recordingPorts().receiptSink,
      outcomeMail: { send: async (notice, to) => (sent.push({ notice, to }), to === "uploader") },
    });
    actAs(FINANCE);
    await receiptService.rejectFinancial(id, "late");
    const [failed] = await notices(id);

    await expect(retryOutcomeNotice(failed.id)).rejects.toMatchObject({ status: 409, message: SEND_FAILED_AGAIN });
    const [again] = await notices(id);
    expect(again.firstFailedAt).toEqual(failed.firstFailedAt);
    expect(again).toMatchObject({ doneAt: null, claimedAt: null });

    setup();
    sent = [];
    await retryStuckItem({ id: String(failed.id), step: "outcome email" });
    expect(sent.map((s) => s.to)).toEqual(["reimbursee"]);
    expect(await notices(id)).toEqual([expect.objectContaining({ doneAt: expect.any(Date) })]);
    expect(await stuckItems()).toEqual([]);
  });

  it("a Retry answers 404 for a notice not stuck and 503 while the mail out is unbound", async () => {
    const sentId = await aliceReceiptIn("financial_review");
    actAs(FINANCE);
    await receiptService.rejectFinancial(sentId, "late");
    const [done] = await notices(sentId);
    await expect(retryOutcomeNotice(done.id)).rejects.toMatchObject({ status: 404 });
    await expect(retryStuckItem({ id: "not-a-number", step: "outcome email" })).rejects.toMatchObject({ status: 404 });

    failSends = true;
    const stuckId = await aliceReceiptIn("financial_review");
    actAs(FINANCE);
    await receiptService.rejectFinancial(stuckId, "late");
    const [stuck] = await notices(stuckId);
    setup(false);
    await expect(retryOutcomeNotice(stuck.id)).rejects.toMatchObject({ status: 503 });
  });

  it("never sends from a claimed row, as after a crash between send and stamp", async () => {
    setup(false);
    const id = await aliceReceiptIn("financial_review");
    actAs(FINANCE);
    await receiptService.rejectFinancial(id, "late");
    await db.receiptOutcomeNotice.updateMany({ where: { receiptId: id }, data: { claimedAt: new Date() } });

    setup();
    expect(await sweepOutcomeNotices()).toEqual({ sent: 0, failed: 0 });
    expect(sent).toEqual([]);
  });
});
