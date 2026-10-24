import { beforeEach, expect, it } from "vitest";
import { db } from "../../db";
import type { SubmitterConfirmations } from "../../contract";
import { receiptService } from "../../services/receiptService";
import { describeDb } from "../helpers/db";
import { ALICE, FINANCE, actAs, clearAll, configure, manualDetails, recordingPorts, stateOf, textFile } from "../helpers/setup";

let ports: ReturnType<typeof recordingPorts>;
let awaiting: Map<string, string[]>;
let confirmed: Array<{ receiptId: string; personId: number }>;

const confirmations: SubmitterConfirmations = {
  awaiting: async (personId) => (personId === ALICE.id ? awaiting : new Map()),
  confirm: async (receiptId, person) => {
    if (!awaiting.has(receiptId)) return false;
    confirmed.push({ receiptId, personId: person.id });
    awaiting.delete(receiptId);
    return true;
  },
};

beforeEach(async () => {
  await clearAll();
  ports = recordingPorts();
  awaiting = new Map();
  confirmed = [];
  configure({ receiptSink: ports.receiptSink, donorSink: ports.donorSink, submitterConfirmations: confirmations });
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
    expect(ports.calls.pushes[0].submitterConfirmation).toEqual({ confirmedByPersonId: ALICE.id, confirmedAt: at!.toISOString() });
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

describeDb("confirming again once the expense exists", () => {
  async function sent() {
    const r = await receiptService.upload(textFile(), "text/plain", { details: manualDetails(), needsReimbursement: true });
    await receiptService.submitterConfirm(r.id);
    return r.id;
  }

  it("My receipts marks the receipt with the fields finance changed, and its pill counts it", async () => {
    const id = await sent();
    expect(await receiptService.countAwaitingSubmitter(ALICE.id)).toBe(0);
    awaiting.set(id, ["reimbursee"]);
    expect((await receiptService.listMine())[0]).toMatchObject({ id, submitterReconfirm: { changedFields: ["reimbursee"] } });
    expect(await receiptService.get(id, "submitter")).toMatchObject({ submitterReconfirm: { changedFields: ["reimbursee"] } });
    expect(await receiptService.countAwaitingSubmitter(ALICE.id)).toBe(1);
  });

  it("the uploader's confirm records it on the expense, audited on the receipt", async () => {
    const id = await sent();
    awaiting.set(id, ["reimbursee"]);
    expect(await receiptService.submitterConfirm(id)).toMatchObject({ id, submitterReconfirm: null });
    expect(confirmed).toEqual([{ receiptId: id, personId: ALICE.id }]);
    expect(await db.receiptAuditLog.count({ where: { receiptId: id, action: "submitter_reconfirmed", userId: ALICE.id } })).toBe(1);
    expect((await receiptService.listMine())[0].submitterReconfirm).toBeNull();
  });

  it("is refused when nothing waits for it", async () => {
    const id = await sent();
    await expect(receiptService.submitterConfirm(id)).rejects.toMatchObject({ status: 409 });
    expect(confirmed).toEqual([]);
  });
});
