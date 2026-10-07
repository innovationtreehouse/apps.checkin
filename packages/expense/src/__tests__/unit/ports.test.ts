/** Crossing guards and inert adapters — no database. */
import { describe, it, expect } from "vitest";
import { callerId } from "../../lib/caller";
import { assertOrg, getExpenseRuntime } from "../../runtime";
import { reimbursementStatus } from "../../services/reimbursementStatus";
import { approveLine } from "../../services/approvalService";
import { detectIntakeFlags, FLAG_AUDIENCE } from "../../lib/flags";
import { ORG } from "../helpers/seed";

describe("callerId", () => {
  it("returns an integer id", () => {
    expect(callerId({ id: 12 })).toBe(12);
  });

  it.each([undefined, null, { id: undefined }, { id: "12" }, { id: 1.5 }])("throws for %j", (p) => {
    expect(() => callerId(p as never)).toThrow(/no person id/);
  });

  it("an id-less session cannot approve, before any query runs", async () => {
    await expect(approveLine({ id: undefined, name: null, isFinance: true, isBoard: false } as never, "e", 1, "x")).rejects.toThrow(/no person id/);
  });
});

describe("runtime", () => {
  it("binds inert adapters for every unbound port", async () => {
    const rt = getExpenseRuntime();
    expect(await rt.catalog.listCategories()).toEqual([]);
    expect(await rt.catalogEvents.eventsAfter(0)).toEqual([]);
    expect(await rt.budgetOwners.list()).toEqual([]);
    expect(await rt.signoff.bucketApprovers(1)).toEqual({ orgLevel: false, approvers: [] });
    expect(await rt.quickbooks.reader.purchasesBetween("2026-01-01", "2026-01-31")).toEqual([]);
    await expect(rt.quickbooks.writer.create("Purchase", {})).rejects.toThrow(/not bound/);
  });

  it("assertOrg accepts only the injected org", () => {
    expect(() => assertOrg(ORG)).not.toThrow();
    expect(() => assertOrg("org-other")).toThrow(/not this org/);
  });
});

describe("X12 reimbursementStatus", () => {
  it("answers not yet paid for every receipt until QuickBooks is read", async () => {
    expect(await reimbursementStatus.forReceipts(["r1", "r2"])).toEqual(new Map([["r1", { paidOn: null }], ["r2", { paidOn: null }]]));
  });

  it("parses its input", async () => {
    await expect(reimbursementStatus.forReceipts([1])).rejects.toThrow();
  });
});

describe("flags", () => {
  const LIMITS = { boardReviewTotalCents: 200_000, capitalEquipmentUnitCents: 50_000 };
  const line = (unitPriceCents: number, totalPriceCents = unitPriceCents) => ({ unitPriceCents, totalPriceCents });

  it("raises tax, $2,000 review and $500 equipment flags; threshold and COI go to the board", () => {
    expect(detectIntakeFlags({ taxCents: 0, receiptTotalCents: 100, lineItems: [line(100)] }, LIMITS)).toEqual([]);
    const reimbursement = { taxCents: 0, receiptTotalCents: 100, lineItems: [line(100)], needsReimbursement: true };
    expect(detectIntakeFlags(reimbursement, LIMITS)).toEqual(["REIMBURSEE_UNKNOWN"]);
    expect(detectIntakeFlags({ ...reimbursement, reimburseePersonId: 9 }, LIMITS)).toEqual([]);
    expect(detectIntakeFlags({ ...reimbursement, backfill: true }, LIMITS)).toEqual([]);
    expect(detectIntakeFlags({ taxCents: 1, receiptTotalCents: 100, lineItems: [line(100)] }, LIMITS)).toEqual(["TAX_ATTACHED"]);
    expect(detectIntakeFlags({ taxCents: 0, receiptTotalCents: 199_999, lineItems: [line(49_999)] }, LIMITS)).toEqual([]);
    expect(detectIntakeFlags({ taxCents: 0, receiptTotalCents: 200_000, lineItems: [line(100)] }, LIMITS)).toEqual(["THRESHOLD_CROSSED"]);
    expect(detectIntakeFlags({ taxCents: 0, receiptTotalCents: 1000, lineItems: [line(50_000, 200_000)] }, LIMITS)).toEqual([
      "THRESHOLD_CROSSED",
      "CAPITAL_EQUIPMENT",
    ]);
    expect(FLAG_AUDIENCE.COI).toBe("BOARD");
    expect(FLAG_AUDIENCE.THRESHOLD_CROSSED).toBe("BOARD");
  });
});
