import { beforeEach, expect, it } from "vitest";
import { db } from "../../db";
import type { OutcomeNotice, ReceiptConfig, ReceiptPrincipal } from "../../contract";
import { sendOutcomeNotices } from "../../services/outcomeNotices";
import { receiptService } from "../../services/receiptService";
import { describeDb } from "../helpers/db";
import { ALICE, BOB, FINANCE, actAs, clearAll, configure, manualDetails, recordingPorts, textFile } from "../helpers/setup";

/** ALICE merged into SURVIVOR; GONE names nobody. */
const SURVIVOR: ReceiptPrincipal = { id: 201, name: "sam", firstName: "Sam", lastName: "Stays", isAdult: true };
const HOUSEMATE: ReceiptPrincipal = { id: 202, name: "hal", firstName: "Hal", lastName: "Stays", isAdult: true };
const GONE = 999;

const personIds: NonNullable<ReceiptConfig["personIds"]> = {
  liveIds: async (ids) => new Map(ids.map((id) => [id, id === GONE ? null : id === ALICE.id ? SURVIVOR.id : id])),
  storedIdsOf: async (id) => (id === SURVIVOR.id ? [SURVIVOR.id, ALICE.id] : [id]),
};
const households: NonNullable<ReceiptConfig["households"]> = {
  householdOf: async (ids) => (ids.includes(SURVIVOR.id) ? [SURVIVOR.id, HOUSEMATE.id] : []),
};

let ports = recordingPorts();
let awaiting: Array<{ receiptId: string; reimburseePersonId: number; changedFields: string[] }> = [];
let confirmedFor: number[] = [];

/** Before the merge: every id names itself. */
function beforeMerge(): void {
  configure({ receiptSink: ports.receiptSink });
}
function afterMerge(over: Partial<ReceiptConfig> = {}): void {
  configure({
    receiptSink: ports.receiptSink,
    personIds,
    households,
    submitterConfirmations: {
      awaiting: async () => awaiting,
      confirm: async (_id, reimburseeId) => {
        confirmedFor.push(reimburseeId);
        return true;
      },
      confirmable: async (ids) => ids,
    },
    ...over,
  });
}

async function aliceUploads(input: Record<string, unknown> = {}): Promise<string> {
  beforeMerge();
  actAs(ALICE);
  return (await receiptService.upload(textFile(), "text/plain", { details: manualDetails(), ...input })).id;
}

/** A receipt open for finance to decide. */
async function aliceOpenReceipt(): Promise<string> {
  const id = await aliceUploads({ needsReimbursement: true });
  await db.receiptDetail.update({ where: { id }, data: { state: "financial_review" } });
  return id;
}

beforeEach(async () => {
  await clearAll();
  ports = recordingPorts();
  awaiting = [];
  confirmedFor = [];
});

describeDb("after merging A into B", () => {
  it("B sees A's receipt and its file, and the stored row still names A", async () => {
    const id = await aliceUploads();
    afterMerge();
    actAs(SURVIVOR);
    expect((await receiptService.listMine()).map((r) => r.id)).toEqual([id]);
    const receipt = await receiptService.get(id, "submitter");
    expect(receipt.uploadedByUserId).toBe(SURVIVOR.id);
    expect((await receiptService.getFile(id, "submitter")).uploadedByUserId).toBe(SURVIVOR.id);
    expect((await db.receipt.findUniqueOrThrow({ where: { id } })).uploadedByUserId).toBe(ALICE.id);
  });

  it("an unrelated caller still does not see it", async () => {
    const id = await aliceUploads();
    afterMerge();
    actAs(BOB);
    expect(await receiptService.listMine()).toEqual([]);
    await expect(receiptService.get(id, "submitter")).rejects.toMatchObject({ status: 404 });
    await expect(receiptService.getFile(id, "submitter")).rejects.toMatchObject({ status: 404 });
  });

  it("a finance holder who is the merged person is refused", async () => {
    const id = await aliceOpenReceipt();
    afterMerge();
    actAs(SURVIVOR);
    await expect(receiptService.approveFinancial(id)).rejects.toMatchObject({ status: 403 });
    await expect(receiptService.rejectFinancial(id, "no")).rejects.toMatchObject({ status: 403 });
  });

  it("a finance holder in the survivor's household is refused", async () => {
    const id = await aliceOpenReceipt();
    afterMerge();
    actAs(HOUSEMATE);
    await expect(receiptService.approveFinancial(id)).rejects.toMatchObject({ status: 403 });
  });

  it("an id that names nobody live is refused for everyone, never cleared", async () => {
    const id = await aliceOpenReceipt();
    await db.receipt.update({ where: { id }, data: { uploadedByUserId: GONE } });
    afterMerge();
    actAs(FINANCE);
    await expect(receiptService.approveFinancial(id)).rejects.toMatchObject({ status: 403 });
    expect((await db.receiptDetail.findUniqueOrThrow({ where: { id } })).state).toBe("financial_review");
  });

  it("an unrelated finance holder may still decide", async () => {
    const id = await aliceOpenReceipt();
    afterMerge();
    actAs(FINANCE);
    await receiptService.rejectFinancial(id, "personal");
    expect((await db.receiptDetail.findUniqueOrThrow({ where: { id } })).state).toBe("rejected");
  });

  it("B confirms what waits for A in review, and is counted", async () => {
    const id = await aliceUploads({ needsReimbursement: true, reimburseePersonId: undefined });
    await db.receipt.update({ where: { id }, data: { uploadedByUserId: BOB.id } });
    afterMerge();
    actAs(SURVIVOR);
    expect((await receiptService.listConfirmations()).map((c) => [c.id, c.reimburseePersonId])).toEqual([[id, SURVIVOR.id]]);
    expect(await receiptService.countToConfirm(SURVIVOR.id)).toBe(1);
    await receiptService.confirmAsReimbursee(id);
    expect((await db.receiptDetail.findUniqueOrThrow({ where: { id } })).reviewedByUserId).toBe(SURVIVOR.id);
  });

  it("once the expense exists, B confirms and expense is told the id it knows", async () => {
    const id = await aliceUploads({ needsReimbursement: true });
    await db.receipt.update({ where: { id }, data: { uploadedByUserId: BOB.id, pushedAt: new Date() } });
    await db.receiptDetail.update({ where: { id }, data: { state: "receipt_finalized" } });
    awaiting = [{ receiptId: id, reimburseePersonId: ALICE.id, changedFields: [] }];
    afterMerge();
    actAs(SURVIVOR);
    expect((await receiptService.listConfirmations()).map((c) => c.id)).toEqual([id]);
    await receiptService.confirmAsReimbursee(id);
    expect(confirmedFor).toEqual([ALICE.id]);
  });

  it("A's own confirmation travels as the survivor's, not as signed on someone's behalf", async () => {
    const id = await aliceUploads({ needsReimbursement: true });
    await receiptService.submitterConfirm(id);
    await db.receipt.update({ where: { id }, data: { pushedAt: null } });
    ports.calls.pushes.length = 0;
    afterMerge();
    actAs(FINANCE);
    await receiptService.push(id);
    expect(ports.calls.pushes[0]).toMatchObject({ submitterId: SURVIVOR.id, submitterConfirmation: { confirmedByPersonId: SURVIVOR.id, onBehalfByPersonId: undefined } });
  });

  it.each([
    ["the survivor", ALICE.id, SURVIVOR.id],
    ["the stored id when it names nobody live", GONE, GONE],
  ])("an approval travels naming %s, and the push goes through", async (_label, stored, pushed) => {
    const id = await aliceUploads();
    await db.receipt.update({ where: { id }, data: { uploadedByUserId: BOB.id, pushedAt: null } });
    await db.receiptDetail.update({ where: { id }, data: { state: "receipt_finalized" } });
    await db.receiptFinanceReview.create({ data: { receiptId: id, outcome: "approved", reasons: ["tax"], decidedByUserId: stored } });
    ports.calls.pushes.length = 0;
    afterMerge();
    actAs(FINANCE);
    await receiptService.push(id);
    expect(ports.calls.pushes[0].financeReview?.decidedByPersonId).toBe(pushed);
    expect((await db.receipt.findUniqueOrThrow({ where: { id } })).pushedAt).not.toBeNull();
    expect((await db.receiptFinanceReview.findUniqueOrThrow({ where: { receiptId: id } })).decidedByUserId).toBe(stored);
  });

  it("an outcome notice names the survivor, once when they are both uploader and reimbursee", async () => {
    const id = await aliceUploads({ needsReimbursement: true });
    await db.receipt.update({ where: { id }, data: { reimburseePersonId: SURVIVOR.id } });
    await db.receiptDetail.update({ where: { id }, data: { state: "submitter_review" } });
    const sent: Array<{ notice: OutcomeNotice; to: string }> = [];
    afterMerge({ outcomeMail: { send: async (notice, to) => (sent.push({ notice, to }), true) } });
    actAs(FINANCE);
    await receiptService.rejectFinancial(id, "personal");
    await sendOutcomeNotices([id]);
    expect(sent.map((s) => [s.to, s.notice.uploaderPersonId])).toEqual([["uploader", SURVIVOR.id]]);
  });
});
