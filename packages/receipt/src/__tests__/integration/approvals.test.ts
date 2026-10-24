import { beforeEach, expect, it } from "vitest";
import { db } from "../../db";
import { orgSettingsService } from "../../services/orgSettingsService";
import { receiptService } from "../../services/receiptService";
import { describeDb } from "../helpers/db";
import type { ReceiptPrincipal } from "../../contract";
import { ALICE, BOB, FINANCE, actAs, clearAll, configure, manualDetails, okOcr, recordingPorts, stateOf, textFile } from "../helpers/setup";

const taxed = () => manualDetails({ tax: "1.00", receiptTotal: "21.00" });

beforeEach(async () => {
  await clearAll();
  configure({ receiptSink: recordingPorts().receiptSink, donorSink: recordingPorts().donorSink });
  actAs(FINANCE);
  await orgSettingsService.update({ taxExempt: true });
  actAs(ALICE);
});

describeDb("financial review", () => {
  it("tax on a tax-exempt org goes to financial_review with reason 'tax'", async () => {
    const r = await receiptService.upload(textFile(), "text/plain", { details: taxed() });
    expect(r.state).toBe("financial_review");
    actAs(FINANCE);
    expect((await receiptService.get(r.id, "finance")).financialReviewReasons).toEqual(["tax"]);
  });

  it("approves a tax exception without a note", async () => {
    const r = await receiptService.upload(textFile(), "text/plain", { details: taxed() });
    actAs(FINANCE);
    await receiptService.approveFinancial(r.id);
    expect(await stateOf(r.id)).toBe("receipt_finalized");
    const row = await db.receiptAuditLog.findFirst({ where: { receiptId: r.id, action: "financial_approved" } });
    expect(row).toMatchObject({ userId: FINANCE.id, valueAfter: null });
  });

  it("an approval is kept on the receipt and carried in the pushed CompletedReceipt", async () => {
    const ports = recordingPorts();
    configure({ receiptSink: ports.receiptSink });
    const r = await receiptService.upload(textFile(), "text/plain", { details: taxed() });
    actAs(FINANCE);
    await receiptService.approveFinancial(r.id);
    const review = await db.receiptFinanceReview.findUnique({ where: { receiptId: r.id } });
    expect(review).toMatchObject({
      outcome: "approved",
      reasons: ["tax"],
      decidedByUserId: FINANCE.id,
      taxCents: 100,
      note: null,
    });
    expect(ports.calls.pushes).toHaveLength(1);
    expect(ports.calls.pushes[0].financeReview).toEqual({
      outcome: "approved",
      reasons: ["tax"],
      decidedByPersonId: FINANCE.id,
      note: null,
      taxCents: 100,
      decidedAt: review!.decidedAt.toISOString(),
    });
    expect(ports.calls.pushes[0].taxReviewRequired).toBe(true);
  });

  it("a receipt that never waited on finance pushes no financeReview", async () => {
    actAs(FINANCE);
    await orgSettingsService.update({ taxExempt: false });
    actAs(ALICE);
    const ports = recordingPorts();
    configure({ receiptSink: ports.receiptSink });
    const r = await receiptService.upload(textFile(), "text/plain", { details: taxed() });
    expect(r.state).toBe("receipt_finalized");
    expect(ports.calls.pushes[0].financeReview).toBeUndefined();
    expect(ports.calls.pushes[0].taxReviewRequired).toBe(false);
    expect(await db.receiptFinanceReview.findUnique({ where: { receiptId: r.id } })).toBeNull();
  });

  it("a non-tax exception (future date) approves without a note", async () => {
    const r = await receiptService.upload(textFile(), "text/plain", { details: manualDetails({ receiptDate: "2999-01-01" }) });
    expect(r.state).toBe("financial_review");
    actAs(FINANCE);
    await receiptService.approveFinancial(r.id);
    expect(await stateOf(r.id)).toBe("receipt_finalized");
  });

  it("refuses a finance user deciding their own receipt", async () => {
    actAs(FINANCE);
    const r = await receiptService.upload(textFile(), "text/plain", { details: taxed() });
    await expect(receiptService.approveFinancial(r.id)).rejects.toMatchObject({ status: 403 });
    await expect(receiptService.rejectFinancial(r.id, "mine")).rejects.toMatchObject({ status: 403 });
    expect(await stateOf(r.id)).toBe("financial_review");
  });

  it("reject records the reason", async () => {
    const r = await receiptService.upload(textFile(), "text/plain", { details: taxed() });
    actAs(FINANCE);
    await receiptService.rejectFinancial(r.id, "  personal purchase ");
    expect(await stateOf(r.id)).toBe("rejected");
    expect(await db.receiptFinanceReview.findUnique({ where: { receiptId: r.id } })).toMatchObject({
      outcome: "rejected",
      reasons: ["tax"],
      decidedByUserId: FINANCE.id,
      note: "personal purchase",
    });
    const row = await db.receiptAuditLog.findFirst({ where: { receiptId: r.id, action: "reject_financial" } });
    expect(row).toMatchObject({ userId: FINANCE.id, valueAfter: "personal purchase" });
  });

  it("rejects without a reason", async () => {
    const r = await receiptService.upload(textFile(), "text/plain", { details: taxed() });
    actAs(FINANCE);
    await receiptService.rejectFinancial(r.id, "   ");
    expect(await stateOf(r.id)).toBe("rejected");
    const row = await db.receiptAuditLog.findFirst({ where: { receiptId: r.id, action: "reject_financial" } });
    expect(row).toMatchObject({ userId: FINANCE.id, valueAfter: null });
  });

  it("a submitter's tax correction drops the earlier finance decision", async () => {
    configure({ ocr: okOcr() });
    const r = await receiptService.upload(textFile(), "text/plain", {});
    expect(r.state).toBe("submitter_review");
    await db.receiptFinanceReview.create({
      data: { receiptId: r.id, outcome: "approved", reasons: ["tax"], decidedByUserId: FINANCE.id, note: "ok" },
    });
    await receiptService.edit(r.id, "submitter", { tax: 1 });
    expect(await db.receiptFinanceReview.findUnique({ where: { receiptId: r.id } })).toBeNull();
  });

  it("the tax check does not apply to an in-kind receipt", async () => {
    const r = await receiptService.upload(textFile(), "text/plain", { details: taxed(), isInKind: true, donor: { self: true } });
    expect(r.state).toBe("receipt_finalized");
  });

  it("the age limit still applies to an in-kind receipt", async () => {
    const r = await receiptService.upload(textFile(), "text/plain", {
      details: manualDetails({ receiptDate: "2020-01-01" }),
      isInKind: true,
      donor: { self: true },
    });
    expect(r.state).toBe("financial_review");
  });
});

describeDb("receipts awaiting finance", () => {
  it("counts the org's receipts in the queues only FINANCE can clear, across uploaders", async () => {
    expect((await receiptService.upload(textFile("A"), "text/plain", { details: taxed() })).state).toBe("financial_review");
    actAs(BOB);
    expect((await receiptService.upload(textFile("B"), "text/plain", { details: taxed() })).state).toBe("duplicate_flagged");
    const off = await receiptService.upload(textFile("C"), "text/plain", { details: manualDetails({ receiptTotal: "1" }) });
    expect(off.state).toBe("validation_failed");
    expect(await receiptService.countAwaitingFinance(FINANCE.id)).toEqual({
      total: 2,
      byState: { financial_review: 1, duplicate_flagged: 1, flow_error: 0 },
    });
  });
});

const REIMBURSEE: ReceiptPrincipal = { ...FINANCE, id: 960, name: "reimbursee" };
const HOUSEMATE: ReceiptPrincipal = { ...FINANCE, id: 970, name: "housemate" };
const INDEPENDENT: ReceiptPrincipal = { ...FINANCE, id: 980, name: "independent" };

describeDb("receipts awaiting a conflicted finance viewer", () => {
  beforeEach(() => {
    const ports = recordingPorts();
    configure({
      receiptSink: ports.receiptSink,
      donorSink: ports.donorSink,
      households: { householdOf: async (ids) => (ids.includes(BOB.id) ? [BOB.id, HOUSEMATE.id] : []) },
    });
  });

  const future = (retailer: string) => ({ details: manualDetails({ retailer, receiptDate: "2999-01-01" }) });

  it("leaves out receipts the viewer uploaded, is reimbursed for, or shares a household with", async () => {
    actAs(FINANCE);
    expect((await receiptService.upload(textFile(), "text/plain", future("Uploaded by finance"))).state).toBe("financial_review");
    actAs(ALICE);
    const reimbursed = await receiptService.upload(textFile(), "text/plain", future("Reimbursed to finance"));
    expect(reimbursed.state).toBe("financial_review");
    await db.receipt.update({ where: { id: reimbursed.id }, data: { reimburseePersonId: REIMBURSEE.id } });
    actAs(BOB);
    const file = textFile();
    await receiptService.upload(file, "text/plain", { details: manualDetails() });
    expect((await receiptService.upload(file, "text/plain", { details: manualDetails() })).state).toBe("duplicate_flagged");

    const counts = (total: number, financial_review: number, duplicate_flagged: number) => ({
      total,
      byState: { financial_review, duplicate_flagged, flow_error: 0 },
    });
    expect(await receiptService.countAwaitingFinance(INDEPENDENT.id)).toEqual(counts(3, 2, 1));
    expect(await receiptService.countAwaitingFinance(FINANCE.id)).toEqual(counts(2, 1, 1));
    expect(await receiptService.countAwaitingFinance(REIMBURSEE.id)).toEqual(counts(2, 1, 1));
    expect(await receiptService.countAwaitingFinance(HOUSEMATE.id)).toEqual(counts(2, 2, 0));
  });
});
