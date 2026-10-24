import { beforeEach, expect, it } from "vitest";
import { db } from "../../db";
import type { AwaitedConfirmation, ReceiptReimbursees, SubmitterConfirmations } from "../../contract";
import { receiptService } from "../../services/receiptService";
import { describeDb } from "../helpers/db";
import { ALICE, BOB, FINANCE, actAs, clearAll, configure, manualDetails, recordingPorts, stateOf, textFile } from "../helpers/setup";

// 101 Alice uploads · 102 Bob is reimbursed · 300 has no account · 500 is on the Board
const NO_ACCOUNT = { id: 300, name: "Nora Noaccount" };
const BOARD = { id: 500, name: "bea", firstName: "Bea", lastName: "Board", isAdult: true, isBoardMember: true };

let ports: ReturnType<typeof recordingPorts>;
let awaiting: AwaitedConfirmation[];
let confirmed: Array<{ receiptId: string; reimburseePersonId: number; signerId: number }>;

const confirmations: SubmitterConfirmations = {
  awaiting: async () => awaiting,
  confirm: async (receiptId, reimburseePersonId, signer) => {
    if (!awaiting.some((a) => a.receiptId === receiptId && a.reimburseePersonId === reimburseePersonId)) return false;
    confirmed.push({ receiptId, reimburseePersonId, signerId: signer.id });
    awaiting = awaiting.filter((a) => a.receiptId !== receiptId);
    return true;
  },
};

const reimbursees: ReceiptReimbursees = {
  search: async () => [],
  byId: async (id) => (id === BOB.id ? { id: BOB.id, name: "Bob Baker" } : id === NO_ACCOUNT.id ? NO_ACCOUNT : null),
  hasAccount: async (id) => id !== NO_ACCOUNT.id,
};

beforeEach(async () => {
  await clearAll();
  ports = recordingPorts();
  awaiting = [];
  confirmed = [];
  configure({ receiptSink: ports.receiptSink, donorSink: ports.donorSink, submitterConfirmations: confirmations, reimbursees });
});

const reviewedAt = async (id: string) => (await db.receiptDetail.findUniqueOrThrow({ where: { id } })).reviewedAt;
const voids = (id: string) => db.receiptAuditLog.findMany({ where: { receiptId: id, action: "submitter_confirmation_voided" } });

/** A reimbursement its submitter confirmed with a total the lines don't match, so it waits in validation_failed. */
async function confirmedInValidation() {
  const r = await receiptService.upload(textFile(), "text/plain", { details: manualDetails(), needsReimbursement: true });
  await receiptService.edit(r.id, "submitter", { receiptTotal: "25.00" });
  await receiptService.submitterConfirm(r.id);
  expect(await stateOf(r.id)).toBe("validation_failed");
  expect(await reviewedAt(r.id)).not.toBeNull();
  const [line] = await db.receiptLineItem.findMany({ where: { receiptId: r.id } });
  return { id: r.id, lineId: line.id };
}

describeDb("the submitter's confirmation of a reimbursement", () => {
  it("is required whatever the intake path: a manual reimbursement waits for it", async () => {
    const r = await receiptService.upload(textFile(), "text/plain", { details: manualDetails(), needsReimbursement: true });
    expect(r.state).toBe("submitter_review");
    expect(ports.calls.pushes).toHaveLength(0);
  });

  it("travels to expense naming who confirmed and when", async () => {
    const r = await receiptService.upload(textFile(), "text/plain", { details: manualDetails(), needsReimbursement: true });
    await receiptService.submitterConfirm(r.id);
    const at = await reviewedAt(r.id);
    expect(ports.calls.pushes[0].submitterConfirmation).toEqual({ confirmedByPersonId: ALICE.id, onBehalfByPersonId: undefined, confirmedAt: at!.toISOString() });
  });

  it("is absent from a manual card charge, which its submitter never reviews", async () => {
    const r = await receiptService.upload(textFile(), "text/plain", { details: manualDetails() });
    expect(r.state).toBe("receipt_finalized");
    expect(ports.calls.pushes[0].submitterConfirmation).toBeUndefined();
  });

  it.each([
    ["receiptDate", { receiptDate: "2020-01-01" }],
    ["shippingCents", { shipping: "1.00" }],
    ["taxCents", { tax: "1.00" }],
    ["discountCents", { discount: "1.00" }],
    ["receiptTotalCents", { receiptTotal: "20.00" }],
  ])("a finance change to %s voids it, audited naming finance and the field", async (field, change) => {
    const { id } = await confirmedInValidation();
    actAs(FINANCE);
    await receiptService.edit(id, "finance", change);
    expect(await reviewedAt(id)).toBeNull();
    expect(await voids(id)).toEqual([expect.objectContaining({ userId: FINANCE.id, fieldChanged: field })]);
  });

  it("once voided, the receipt goes back to its submitter's review before finance", async () => {
    const { id } = await confirmedInValidation();
    actAs(FINANCE);
    await receiptService.edit(id, "finance", { receiptTotal: "20.00" });
    await receiptService.resubmit(id, "finance");
    expect(await stateOf(id)).toBe("submitter_review");
    expect(ports.calls.pushes).toHaveLength(0);
  });

  it.each([
    ["adding a line", (id: string) => receiptService.addLine(id, "finance", { description: "Washer", quantity: 1, unitPrice: 5 })],
    ["editing a line", (id: string, lineId: number) => receiptService.editLine(id, "finance", lineId, { quantity: 3 })],
    ["removing a line", (id: string, lineId: number) => receiptService.deleteLine(id, "finance", lineId)],
  ])("%s by finance voids it", async (_label, change) => {
    const { id, lineId } = await confirmedInValidation();
    actAs(FINANCE);
    await change(id, lineId);
    expect(await reviewedAt(id)).toBeNull();
    expect(await voids(id)).toEqual([expect.objectContaining({ fieldChanged: "lineItems" })]);
  });

  it.each([
    ["the retailer", { retailer: "Other Store" }],
    ["the currency", { currency: "CAD" }],
  ])("a finance change to %s does not void it", async (_label, change) => {
    const { id } = await confirmedInValidation();
    actAs(FINANCE);
    await receiptService.edit(id, "finance", change);
    expect(await reviewedAt(id)).not.toBeNull();
    expect(await voids(id)).toEqual([]);
  });

  it("the submitter's own correction does not void it", async () => {
    const { id, lineId } = await confirmedInValidation();
    await receiptService.edit(id, "submitter", { receiptTotal: "20.00" });
    await receiptService.editLine(id, "submitter", lineId, { quantity: 2 });
    expect(await reviewedAt(id)).not.toBeNull();
    expect(await voids(id)).toEqual([]);
  });

  it("a finance change to a card charge never involves its submitter", async () => {
    const r = await receiptService.upload(textFile(), "text/plain", { details: manualDetails({ receiptTotal: "25.00" }) });
    expect(r.state).toBe("validation_failed");
    actAs(FINANCE);
    await receiptService.edit(r.id, "finance", { receiptTotal: "20.00" });
    await receiptService.resubmit(r.id, "finance");
    expect(await stateOf(r.id)).toBe("receipt_finalized");
    expect(await voids(r.id)).toEqual([]);
  });
});

/** A manual reimbursement Alice uploads for `reimburseePersonId`, waiting in submitter review. */
async function uploadFor(reimburseePersonId: number) {
  actAs(ALICE);
  const r = await receiptService.upload(textFile(), "text/plain", { details: manualDetails(), needsReimbursement: true, reimburseePersonId });
  expect(r.state).toBe("submitter_review");
  return r.id;
}

describeDb("the person reimbursed confirms, not the uploader", () => {
  it("the uploader cannot confirm a reimbursement for someone else", async () => {
    const id = await uploadFor(BOB.id);
    await expect(receiptService.submitterConfirm(id)).rejects.toMatchObject({ status: 403 });
    expect(await stateOf(id)).toBe("submitter_review");
  });

  it("the reimbursee sees it to confirm, and their pill counts it; the uploader's does not", async () => {
    const id = await uploadFor(BOB.id);
    expect(await receiptService.countAwaitingSubmitter(ALICE.id)).toBe(0);
    expect(await receiptService.countAwaitingSubmitter(BOB.id)).toBe(1);
    actAs(BOB);
    expect(await receiptService.listConfirmations()).toEqual([
      expect.objectContaining({ id, reimburseePersonId: BOB.id, onBehalf: false, changedFields: [], lineItems: [expect.objectContaining({ description: "Bolt", reimburseePersonId: BOB.id })] }),
    ]);
  });

  it("the reimbursee's confirmation moves the receipt on and travels as theirs", async () => {
    const id = await uploadFor(BOB.id);
    actAs(BOB);
    await receiptService.confirmAsReimbursee(id);
    expect(await stateOf(id)).toBe("receipt_finalized");
    expect((await db.receiptDetail.findUniqueOrThrow({ where: { id } })).reviewedByUserId).toBe(BOB.id);
    expect(ports.calls.pushes[0].submitterConfirmation).toMatchObject({ confirmedByPersonId: BOB.id, onBehalfByPersonId: undefined });
  });

  it("nobody else confirms it: not finance, and not a Board member while the reimbursee has an account", async () => {
    const id = await uploadFor(BOB.id);
    actAs(FINANCE);
    await expect(receiptService.confirmAsReimbursee(id)).rejects.toMatchObject({ status: 403 });
    actAs(BOARD);
    await expect(receiptService.confirmAsReimbursee(id)).rejects.toMatchObject({ status: 403 });
    expect(await receiptService.listConfirmations()).toEqual([]);
  });

  it("an uploader reimbursing themself confirms in their own review, as before", async () => {
    const r = await receiptService.upload(textFile(), "text/plain", { details: manualDetails(), needsReimbursement: true });
    await receiptService.submitterConfirm(r.id);
    expect(ports.calls.pushes[0].submitterConfirmation).toMatchObject({ confirmedByPersonId: ALICE.id, onBehalfByPersonId: undefined });
  });
});

describeDb("a Board member confirms for a reimbursee with no account", () => {
  it("lists it, and the confirmation records that it was on their behalf, and by whom", async () => {
    const id = await uploadFor(NO_ACCOUNT.id);
    actAs(BOARD);
    expect(await receiptService.listConfirmations()).toEqual([expect.objectContaining({ id, onBehalf: true })]);
    await receiptService.confirmAsReimbursee(id);
    expect(ports.calls.pushes[0].submitterConfirmation).toMatchObject({ confirmedByPersonId: NO_ACCOUNT.id, onBehalfByPersonId: BOARD.id });
    expect(await db.receiptAuditLog.findFirst({ where: { receiptId: id, action: "submitter_review_confirmed" } })).toMatchObject({
      userId: BOARD.id,
      valueAfter: `on behalf of ${NO_ACCOUNT.id}`,
    });
  });

  it("a Board member who is party to the receipt cannot", async () => {
    const id = await uploadFor(NO_ACCOUNT.id);
    actAs({ ...ALICE, isBoardMember: true });
    await expect(receiptService.confirmAsReimbursee(id)).rejects.toMatchObject({ status: 403 });
    expect(await receiptService.listConfirmations()).toEqual([]);
  });

  it("someone who is not on the Board cannot", async () => {
    const id = await uploadFor(NO_ACCOUNT.id);
    actAs(BOB);
    await expect(receiptService.confirmAsReimbursee(id)).rejects.toMatchObject({ status: 403 });
  });
});

describeDb("confirming again once the expense exists", () => {
  async function sentFor(reimburseePersonId: number) {
    const id = await uploadFor(reimburseePersonId);
    actAs(reimburseePersonId === BOB.id ? BOB : BOARD);
    await receiptService.confirmAsReimbursee(id);
    awaiting = [{ receiptId: id, reimburseePersonId, changedFields: ["reimbursee"] }];
    return id;
  }

  it("lists it for the reimbursee with the fields finance changed, and their pill counts it", async () => {
    const id = await sentFor(BOB.id);
    expect(await receiptService.countAwaitingSubmitter(BOB.id)).toBe(1);
    actAs(BOB);
    expect(await receiptService.listConfirmations()).toEqual([expect.objectContaining({ id, changedFields: ["reimbursee"] })]);
  });

  it("the reimbursee's confirmation records it on the expense, audited on the receipt", async () => {
    const id = await sentFor(BOB.id);
    actAs(BOB);
    expect(await receiptService.confirmAsReimbursee(id)).toMatchObject({ id, changedFields: [] });
    expect(confirmed).toEqual([{ receiptId: id, reimburseePersonId: BOB.id, signerId: BOB.id }]);
    expect(await db.receiptAuditLog.count({ where: { receiptId: id, action: "submitter_reconfirmed", userId: BOB.id } })).toBe(1);
    expect(await receiptService.listConfirmations()).toEqual([]);
  });

  it("a Board member confirms again for a reimbursee with no account", async () => {
    const id = await sentFor(NO_ACCOUNT.id);
    actAs(BOARD);
    await receiptService.confirmAsReimbursee(id);
    expect(confirmed).toEqual([{ receiptId: id, reimburseePersonId: NO_ACCOUNT.id, signerId: BOARD.id }]);
  });

  it("is refused when nothing waits for it", async () => {
    const id = await sentFor(BOB.id);
    awaiting = [];
    actAs(BOB);
    await expect(receiptService.confirmAsReimbursee(id)).rejects.toMatchObject({ status: 409 });
  });
});
