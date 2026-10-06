/**
 * S2 callee — receiveCompletedReceipt driven with the shared contract fixtures
 * (@inventory/receipt-contract-fixtures, seam "S2-expense-receipt"). The "already
 * applied" check lives in the service, so a repeat in-process call changes nothing.
 */
import { describe, it, expect } from "vitest";
import { fixture } from "@inventory/receipt-contract-fixtures";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { receiveCompletedReceipt } from "../../services/intakeService";

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
