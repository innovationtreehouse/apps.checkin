/**
 * S2 callee — receiveCompletedReceipt driven with the shared contract fixtures
 * (@inventory/receipt-contract-fixtures, seam "S2-expense-receipt"). The "already
 * applied" check lives in the service, so a repeat in-process call changes nothing.
 */
import { describe, it, expect } from "vitest";
import { fixture } from "@inventory/receipt-contract-fixtures";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { receiveCompletedReceipt, replayReceivedPayloads } from "../../services/intakeService";

type Receipt = { receiptId: string; orgId: string; taxCents: number; lineItems: Array<{ gtin13?: string | null; isProvisional?: boolean }> };

const allRecognized = fixture<Receipt>("S2-expense-receipt/all-recognized-gtin");
const hasProvisional = fixture<Receipt>("S2-expense-receipt/has-provisional");

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
    await receiveCompletedReceipt({ ...allRecognized, needsReimbursement: true, reimburseePersonId: 9 });
    expect((await db.expense.findFirst({ where: { id: allRecognized.receiptId } }))!.reimburseePersonId).toBe(9);

    await receiveCompletedReceipt({ ...hasProvisional });
    expect((await db.expense.findFirst({ where: { id: hasProvisional.receiptId } }))!.reimburseePersonId).toBeNull();
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

  it("raises a TAX_ATTACHED flag for finance when the receipt carries tax", async () => {
    await receiveCompletedReceipt({ ...allRecognized, taxCents: 125 });

    const flags = await db.expenseFlag.findMany({ where: { expenseId: allRecognized.receiptId } });
    expect(flags.map((f) => [f.kind, f.audience])).toEqual([["TAX_ATTACHED", "FINANCE"]]);
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

  it("the catch-up sweep replays a payload left received or failed", async () => {
    await db.receivedExpensePayload.create({
      data: { orgId: allRecognized.orgId, receiptId: allRecognized.receiptId, payloadJson: JSON.stringify(allRecognized), status: "received" },
    });

    expect(await replayReceivedPayloads()).toEqual({ applied: 1, failed: 0 });

    expect((await snapshot(allRecognized.receiptId)).expenses).toBe(1);
  });
});
