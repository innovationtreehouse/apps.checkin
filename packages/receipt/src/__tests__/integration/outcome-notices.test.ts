import { beforeEach, expect, it } from "vitest";
import { db } from "../../db";
import type { OutcomeNotice } from "../../contract";
import { OUTCOME_ATTEMPTS, oweOutcomeNotice, sweepOutcomeNotices } from "../../services/outcomeNotices";
import { receiptService } from "../../services/receiptService";
import { describeDb } from "../helpers/db";
import { ALICE, BOB, FINANCE, TEST_ORG_ID, actAs, clearAll, configure, manualDetails, recordingPorts, stateOf, textFile } from "../helpers/setup";

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
  const r = await receiptService.upload(textFile(), "text/plain", { details: manualDetails({ retailer: "Acme Hardware", receiptDate: "2026-10-02", receiptTotal: "25.00" }) });
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
    const a = await receiptService.upload(file, "text/plain", {});
    const b = await receiptService.upload(file, "text/plain", { details: manualDetails() });
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
    const finalized = await receiptService.upload(textFile(), "text/plain", { details: manualDetails({ retailer: "Elsewhere" }) });

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
    await expect(
      db.$transaction(async (tx) => {
        await tx.receiptDetail.update({ where: { id }, data: { state: "rejected" } });
        await oweOutcomeNotice(tx, TEST_ORG_ID, id, "receipt_rejected");
        throw new Error("crash before commit");
      }),
    ).rejects.toThrow("crash before commit");
    expect(await stateOf(id)).toBe("financial_review");
    expect(await notices(id)).toHaveLength(0);

    actAs(FINANCE);
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
    expect(await notices(id)).toEqual([expect.objectContaining({ doneAt: null, attempts: 0 })]);

    setup();
    expect(await sweepOutcomeNotices()).toEqual({ sent: 2, failed: 0 });
    expect(await sweepOutcomeNotices()).toEqual({ sent: 0, failed: 0 });
    expect(sent.map((s) => s.to)).toEqual(["uploader", "reimbursee"]);
  });

  it("resends only the copy that failed", async () => {
    const id = await aliceReceiptIn("financial_review", BOB.id);
    configure({
      receiptSink: recordingPorts().receiptSink,
      outcomeMail: { send: async (notice, to) => (sent.push({ notice, to }), to === "uploader") },
    });
    actAs(FINANCE);
    await receiptService.rejectFinancial(id, "late");
    expect(await notices(id)).toEqual([expect.objectContaining({ uploaderSentAt: expect.any(Date), reimburseeSentAt: null, doneAt: null, attempts: 1 })]);

    setup();
    sent = [];
    expect(await sweepOutcomeNotices()).toEqual({ sent: 1, failed: 0 });
    expect(sent.map((s) => s.to)).toEqual(["reimbursee"]);
  });

  it("retries a failed send up to its limit, then stops", async () => {
    failSends = true;
    const id = await aliceReceiptIn("financial_review");
    actAs(FINANCE);
    await receiptService.rejectFinancial(id, "late");
    for (let i = 1; i < OUTCOME_ATTEMPTS + 2; i++) await sweepOutcomeNotices();

    expect(sent).toHaveLength(OUTCOME_ATTEMPTS);
    expect(await notices(id)).toEqual([expect.objectContaining({ uploaderSentAt: null, doneAt: expect.any(Date), attempts: OUTCOME_ATTEMPTS })]);
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
