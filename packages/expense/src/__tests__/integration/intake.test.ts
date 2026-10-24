/**
 * S2 callee — receiveCompletedReceipt driven with the shared contract fixtures
 * (@checkin/receipt-contract-fixtures, seam "S2-expense-receipt"). The "already
 * applied" check lives in the service, so a repeat in-process call changes nothing.
 */
import { describe, it, expect } from "vitest";
import { fixture } from "@checkin/receipt-contract-fixtures";
import { describeDb } from "../helpers/db";
import { bindPorts, directory, principal, seedExpense, ORG } from "../helpers/seed";
import { db } from "../../db";
import { receiveCompletedReceipt, replayReceivedPayloads } from "../../services/intakeService";
import { updateExpenseSettings } from "../../services/settingsService";
import { storedTaxNeedsFinance } from "../../services/flagService";

type Receipt = { receiptId: string; orgId: string; taxCents: number; lineItems: Array<{ gtin13?: string | null; isProvisional?: boolean }> };

const allRecognized = fixture<Receipt>("S2-expense-receipt/all-recognized-gtin");
const hasProvisional = fixture<Receipt>("S2-expense-receipt/has-provisional");
const financeApproved = fixture<Receipt>("S2-expense-receipt/finance-approved-tax");

async function snapshot(receiptId: string) {
  return {
    expenses: await db.expense.count({ where: { id: receiptId } }),
    lines: await db.expenseLineItem.count({ where: { expenseId: receiptId } }),
    approvals: await db.lineItemOwnerApproval.count({ where: { expenseId: receiptId } }),
    payloads: await db.receivedExpensePayload.findMany({ where: { receiptId } }),
    audit: await db.expenseAuditLog.count({ where: { expenseId: receiptId } }),
  };
}

describe("S2 intake — contract guard", () => {
  it("rejects a payload for another org", async () => {
    await expect(receiveCompletedReceipt({ ...allRecognized, orgId: "org-other" })).rejects.toThrow(/not this org/);
  });

  it("rejects a malformed payload", async () => {
    await expect(receiveCompletedReceipt({ receiptId: "x" })).rejects.toThrow();
  });
});

describeDb("S2 intake — all-recognized-gtin fixture", () => {
  it("persists the expense, its lines and an applied payload row, and starts the flow", async () => {
    expect(await receiveCompletedReceipt(allRecognized)).toEqual({ receiptId: allRecognized.receiptId, status: "created" });

    const s = await snapshot(allRecognized.receiptId);
    expect(s.expenses).toBe(1);
    expect(s.lines).toBe(allRecognized.lineItems.length);
    expect(s.approvals).toBe(allRecognized.lineItems.length);
    expect(s.payloads.map((p) => p.status)).toEqual(["applied"]);
    const expense = await db.expense.findFirst({ where: { id: allRecognized.receiptId } });
    expect(expense!.state).toBe("assign_ownership");
  });

  it("carries reimburseePersonId onto the expense; absent, the expense has no reimbursee", async () => {
    bindPorts({ signoff: directory({}) });
    await receiveCompletedReceipt({ ...allRecognized, needsReimbursement: true, reimburseePersonId: 9 });
    expect((await db.expense.findFirst({ where: { id: allRecognized.receiptId } }))!.reimburseePersonId).toBe(9);

    await receiveCompletedReceipt({ ...hasProvisional });
    expect((await db.expense.findFirst({ where: { id: hasProvisional.receiptId } }))!.reimburseePersonId).toBeNull();
  });

  it("a reimbursement without reimburseePersonId raises REIMBURSEE_UNKNOWN to FINANCE; with one, or as a card charge, it does not", async () => {
    const flagsOf = async (id: string) => (await db.expenseFlag.findMany({ where: { expenseId: id, kind: "REIMBURSEE_UNKNOWN" } })).map((f) => f.audience);
    bindPorts({ signoff: directory({}) });
    await receiveCompletedReceipt({ ...allRecognized, needsReimbursement: true });
    expect(await flagsOf(allRecognized.receiptId)).toEqual(["FINANCE"]);

    await receiveCompletedReceipt({ ...hasProvisional, needsReimbursement: true, reimburseePersonId: 9 });
    await receiveCompletedReceipt({ ...allRecognized, receiptId: "r-card" });
    expect(await flagsOf(hasProvisional.receiptId)).toEqual([]);
    expect(await flagsOf("r-card")).toEqual([]);
  });

  it("a reimburseePersonId that names no Person is held like a missing one", async () => {
    bindPorts({ signoff: directory({ unknownPeople: [9] }) });
    await receiveCompletedReceipt({ ...allRecognized, needsReimbursement: true, reimburseePersonId: 9 });

    expect((await db.expense.findFirst({ where: { id: allRecognized.receiptId } }))!.reimburseePersonId).toBeNull();
    const flags = await db.expenseFlag.findMany({ where: { expenseId: allRecognized.receiptId, kind: "REIMBURSEE_UNKNOWN" } });
    expect(flags.map((f) => f.detail)).toEqual(["receipt named Person 9, not found"]);
  });

  it("a repeat call returns already_applied and changes nothing", async () => {
    await receiveCompletedReceipt(allRecognized);
    const before = await snapshot(allRecognized.receiptId);

    expect(await receiveCompletedReceipt(allRecognized)).toEqual({ receiptId: allRecognized.receiptId, status: "already_applied" });

    expect(await snapshot(allRecognized.receiptId)).toEqual(before);
  });

  it("re-applies a payload row left failed", async () => {
    await db.receivedExpensePayload.create({
      data: { orgId: allRecognized.orgId, receiptId: allRecognized.receiptId, payloadJson: "{}", status: "failed", failureReason: "boom" },
    });

    expect((await receiveCompletedReceipt(allRecognized)).status).toBe("created");

    const s = await snapshot(allRecognized.receiptId);
    expect(s.expenses).toBe(1);
    expect(s.payloads).toHaveLength(1);
    expect(s.payloads[0]).toMatchObject({ status: "applied", failureReason: null });
  });

  it("raises no TAX_ATTACHED when receipt finance review approved that tax", async () => {
    await receiveCompletedReceipt(financeApproved);
    expect(await db.expenseFlag.count({ where: { expenseId: financeApproved.receiptId, kind: "TAX_ATTACHED" } })).toBe(0);
  });

  it("raises no TAX_ATTACHED when the receipt org does not hold tax for review", async () => {
    await receiveCompletedReceipt({ ...allRecognized, taxCents: 125, taxReviewRequired: false });
    expect(await db.expenseFlag.count({ where: { expenseId: allRecognized.receiptId, kind: "TAX_ATTACHED" } })).toBe(0);
  });

  it("raises TAX_ATTACHED when the tax differs from the amount finance approved", async () => {
    await receiveCompletedReceipt({ ...financeApproved, taxCents: 90, receiptTotalCents: 3090 });
    const flags = await db.expenseFlag.findMany({ where: { expenseId: financeApproved.receiptId } });
    expect(flags.map((f) => [f.kind, f.audience])).toEqual([["TAX_ATTACHED", "FINANCE"]]);
  });

  it("raises a TAX_ATTACHED flag for finance when the receipt carries tax", async () => {
    await receiveCompletedReceipt({ ...allRecognized, taxCents: 125 });

    const flags = await db.expenseFlag.findMany({ where: { expenseId: allRecognized.receiptId } });
    expect(flags.map((f) => [f.kind, f.audience])).toEqual([["TAX_ATTACHED", "FINANCE"]]);
  });

  it("stores the receipt's finance approval and review-required flag with the expense; a receipt with neither stores none", async () => {
    await receiveCompletedReceipt(financeApproved);
    expect(await db.expenseReceiptReview.findUnique({ where: { expenseId: financeApproved.receiptId } })).toEqual({
      expenseId: financeApproved.receiptId,
      taxReviewRequired: true,
      reasons: ["tax"],
      approvedTaxCents: 80,
      approvedByUserId: 12,
      note: null,
      approvedAt: new Date("2026-06-02T09:30:00.000Z"),
    });

    await receiveCompletedReceipt(allRecognized);
    expect(await db.expenseReceiptReview.findUnique({ where: { expenseId: allRecognized.receiptId } })).toBeNull();
  });

  it("stores the review-required flag when finance never approved", async () => {
    await receiveCompletedReceipt({ ...allRecognized, taxCents: 125, receiptTotalCents: 3125, taxReviewRequired: false });
    expect(await db.expenseReceiptReview.findUnique({ where: { expenseId: allRecognized.receiptId } })).toMatchObject({
      taxReviewRequired: false,
      reasons: [],
      approvedTaxCents: null,
      approvedByUserId: null,
      approvedAt: null,
    });
  });

  it("later checks read the tax decision from the stored expense", async () => {
    await receiveCompletedReceipt(financeApproved);
    expect(await storedTaxNeedsFinance(financeApproved.receiptId)).toBe(false);
    await db.expense.update({ where: { id: financeApproved.receiptId }, data: { taxCents: 90 } });
    expect(await storedTaxNeedsFinance(financeApproved.receiptId)).toBe(true);

    await receiveCompletedReceipt({ ...allRecognized, taxCents: 125, receiptTotalCents: 3125 });
    expect(await storedTaxNeedsFinance(allRecognized.receiptId)).toBe(true);
  });

  it("freezes the Everyday amount check with the limits in force at intake", async () => {
    await updateExpenseSettings(ORG, { everydayTotalLimitCents: 1 }, principal(5, { isBoard: true }));
    await receiveCompletedReceipt(allRecognized);

    const row = await db.expense.findUniqueOrThrow({ where: { id: allRecognized.receiptId } });
    expect([row.everydayWithinLimits, row.everydayTotalLimitCents, row.everydayItemLimitCents]).toEqual([false, 1, 25_000]);
  });
});

describeDb("S2 intake — has-provisional fixture", () => {
  it("tracks each provisional GTIN once across replays", async () => {
    await receiveCompletedReceipt(hasProvisional);
    await db.receivedExpensePayload.updateMany({ data: { status: "failed" } });
    await receiveCompletedReceipt(hasProvisional);

    const gtins = hasProvisional.lineItems.filter((l) => l.isProvisional && l.gtin13).map((l) => l.gtin13!);
    expect(gtins.length).toBeGreaterThan(0);
    const rows = await db.provisionalItemMap.findMany({ where: { provisionalGtin13: { in: gtins } } });
    expect(rows).toHaveLength(new Set(gtins).size);
    expect(rows.every((r) => r.status === "pending")).toBe(true);
  });
});

describeDb("S2 intake — applied is written only after processing commits", () => {
  it("a row left received (a crash before the expense existed) is processed on retry", async () => {
    await db.receivedExpensePayload.create({
      data: { orgId: allRecognized.orgId, receiptId: allRecognized.receiptId, payloadJson: "{}", status: "received" },
    });

    expect((await receiveCompletedReceipt(allRecognized)).status).toBe("created");

    const s = await snapshot(allRecognized.receiptId);
    expect(s.expenses).toBe(1);
    expect(s.payloads.map((p) => p.status)).toEqual(["applied"]);
  });

  it("a row left received after processing finished is marked applied without reprocessing", async () => {
    await receiveCompletedReceipt(allRecognized);
    await db.receivedExpensePayload.updateMany({ data: { status: "received" } });
    const before = await snapshot(allRecognized.receiptId);

    expect((await receiveCompletedReceipt(allRecognized)).status).toBe("already_applied");

    const after = await snapshot(allRecognized.receiptId);
    expect({ ...after, payloads: [] }).toEqual({ ...before, payloads: [] });
    expect(after.payloads.map((p) => p.status)).toEqual(["applied"]);
  });

  it("a crash after the expense commits but before provisionals are tracked is finished on retry", async () => {
    await receiveCompletedReceipt(hasProvisional);
    await db.provisionalItemMap.deleteMany();
    await db.receivedExpensePayload.updateMany({ data: { status: "received" } });

    expect((await receiveCompletedReceipt(hasProvisional)).status).toBe("already_applied");

    const gtins = hasProvisional.lineItems.filter((l) => l.isProvisional && l.gtin13).map((l) => l.gtin13!);
    expect(await db.provisionalItemMap.count({ where: { provisionalGtin13: { in: gtins } } })).toBe(new Set(gtins).size);
  });

  it("two concurrent calls with provisional lines track each GTIN once, and neither fails", async () => {
    await Promise.all([receiveCompletedReceipt(hasProvisional), receiveCompletedReceipt(hasProvisional)]);

    const gtins = hasProvisional.lineItems.filter((l) => l.isProvisional && l.gtin13).map((l) => l.gtin13!);
    expect(await db.provisionalItemMap.count({ where: { provisionalGtin13: { in: gtins } } })).toBe(new Set(gtins).size);
  });

  it("two concurrent calls create one expense and one flow, and neither fails", async () => {
    const results = await Promise.all([receiveCompletedReceipt(allRecognized), receiveCompletedReceipt(allRecognized)]);

    expect(results.map((r) => r.status).sort()).toEqual(["already_applied", "created"]);
    const s = await snapshot(allRecognized.receiptId);
    expect(s.expenses).toBe(1);
    expect(s.approvals).toBe(allRecognized.lineItems.length);
    expect(await db.expenseAuditLog.count({ where: { expenseId: allRecognized.receiptId, action: "financial_flow_started" } })).toBe(1);
    expect(s.payloads.map((p) => p.status)).toEqual(["applied"]);
  });

  it("refuses a replay whose payload differs from the one an existing expense was built from", async () => {
    await receiveCompletedReceipt(allRecognized);
    await db.receivedExpensePayload.updateMany({ data: { status: "received" } });
    const before = await snapshot(allRecognized.receiptId);

    await expect(receiveCompletedReceipt({ ...allRecognized, backfill: true })).rejects.toMatchObject({ status: 409 });

    expect(await snapshot(allRecognized.receiptId)).toEqual(before);
  });

  it("starts the flow from the stored expense's backfill flag, not the payload's", async () => {
    await seedExpense({ id: allRecognized.receiptId, orgId: allRecognized.orgId, backfill: false });

    await receiveCompletedReceipt({ ...allRecognized, backfill: true });

    expect((await db.expense.findFirst({ where: { id: allRecognized.receiptId } }))!.state).toBe("assign_ownership");
  });

  it("the catch-up sweep replays a payload left received or failed", async () => {
    await db.receivedExpensePayload.create({
      data: { orgId: allRecognized.orgId, receiptId: allRecognized.receiptId, payloadJson: JSON.stringify(allRecognized), status: "received" },
    });

    expect(await replayReceivedPayloads()).toEqual({ applied: 1, failed: 0 });

    expect((await snapshot(allRecognized.receiptId)).expenses).toBe(1);
  });
});
