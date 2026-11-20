/**
 * Unit coverage for capital classification, approval terminal classification and the reject helper.
 *
 * The auto-transition (checkApprovalAutoTransition) fires once every approval is
 * terminal; "rejected" is terminal-but-non-proceeding and refuses the whole
 * expense via anyRejected.
 */
import { describe, it, expect } from "vitest";
import { createActor } from "xstate";
import { capitalThresholdsUnset, classifyCapital, isTerminalApproval, anyRejected } from "../../lib/expense-rules";
import { DEFAULT_EXPENSE_SETTINGS } from "../../services/settingsService";
import { unitCosts, unitsOf } from "../../lib/capital-register";
import { bookedLineCents } from "../../qb-write";
import { expenseMachine } from "../../workflows/expense.machine";

const on = { capitalReviewEnabled: true, capitalTotalThresholdCents: 500_000, capitalLineItemThresholdCents: 250_000 };

describe("classifyCapital", () => {
  it("is capital at or over a threshold, and not below it", () => {
    expect(classifyCapital(500_000, [], on)).toBe(true);
    expect(classifyCapital(0, [250_000], on)).toBe(true);
    expect(classifyCapital(499_999, [249_999], on)).toBe(false);
  });

  it("sends nothing to capital review while review is off", () => {
    expect(classifyCapital(1_000_000, [1_000_000], { ...on, capitalReviewEnabled: false })).toBe(false);
  });

  it.each([
    { capitalTotalThresholdCents: null },
    { capitalLineItemThresholdCents: null },
  ])("holds every expense at capital_review while review is on and a threshold is unset (%o)", (unset) => {
    const settings = { ...on, ...unset };
    expect(capitalThresholdsUnset(settings)).toBe(true);
    const hasCapital = classifyCapital(1, [1], settings);
    expect(hasCapital).toBe(true);

    const actor = createActor(expenseMachine).start();
    actor.send({ type: "FLOW_STARTED", allOwnersResolved: true });
    actor.send({ type: "ALL_APPROVALS_TERMINAL", hasCapital, anyRejected: false });
    expect(actor.getSnapshot().value).toBe("capital_review");
    actor.stop();
  });

  it("is not unset while review is off or both thresholds are set", () => {
    expect(capitalThresholdsUnset(on)).toBe(false);
    expect(capitalThresholdsUnset({ ...on, capitalReviewEnabled: false, capitalTotalThresholdCents: null })).toBe(false);
  });

  // A purchase's unit cost is its share of the booked line; a gift's, its share of the line's cost.
  const purchaseUnits = (expense: { taxCents: number; shippingCents: number; discountCents: number }, lines: { id: number; totalPriceCents: number; quantity: number }[]) => {
    const booked = bookedLineCents(expense, lines);
    return lines.map((l) => unitCosts(booked.get(l.id)!, unitsOf(l.quantity))[0]);
  };
  const giftUnits = (lines: { costCents: number; quantity: number }[]) => lines.map((l) => unitCosts(l.costCents, unitsOf(l.quantity))[0]);
  const cad = { capitalReviewEnabled: true, capitalTotalThresholdCents: 250_000, capitalLineItemThresholdCents: 100_000 };
  const none = { taxCents: 0, shippingCents: 0, discountCents: 0 };

  it("six $450 chairs as six lines, $2,700 in all, go to review bought or given (CAD-1)", () => {
    const chairs = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, totalPriceCents: 45_000, quantity: 1 }));
    expect(classifyCapital(270_000, purchaseUnits(none, chairs), cad)).toBe(true);
    expect(classifyCapital(270_000, giftUnits(chairs.map(() => ({ costCents: 45_000, quantity: 1 }))), cad)).toBe(true);
  });

  it("a $1,000 table with $80 tax, $50 shipping and $100 off costs $1,030 bought or given (CAD-2, CAD-15)", () => {
    const table = { taxCents: 8_000, shippingCents: 5_000, discountCents: 10_000 };
    expect(purchaseUnits(table, [{ id: 1, totalPriceCents: 100_000, quantity: 1 }])).toEqual([103_000]);
    expect(giftUnits([{ costCents: 103_000, quantity: 1 }])).toEqual([103_000]);
  });

  it("the unit threshold counts a unit's share of tax and shipping (CAD-2)", () => {
    const lines = [{ id: 1, totalPriceCents: 95_000, quantity: 1 }];
    expect(classifyCapital(95_000, purchaseUnits(none, lines), cad)).toBe(false);
    expect(classifyCapital(105_000, purchaseUnits({ ...none, taxCents: 10_000 }, lines), cad)).toBe(true);
  });

  it("an org with no settings row has review on with thresholds unset", () => {
    expect(capitalThresholdsUnset(DEFAULT_EXPENSE_SETTINGS)).toBe(true);
    expect(classifyCapital(0, [], DEFAULT_EXPENSE_SETTINGS)).toBe(true);
  });
});

describe("isTerminalApproval", () => {
  it("treats decided statuses as terminal", () => {
    expect(isTerminalApproval("approved")).toBe(true);
    expect(isTerminalApproval("rejected")).toBe(true);
  });

  it("treats undecided statuses as non-terminal", () => {
    expect(isTerminalApproval("pending")).toBe(false);
    expect(isTerminalApproval("exception_raised")).toBe(false);
    expect(isTerminalApproval("unknown")).toBe(false);
  });

  it("a finance-assigned line waits for its new bucket's approver", () => {
    expect(isTerminalApproval("finance_assigned")).toBe(false);
  });
});

describe("anyRejected", () => {
  it("is true when at least one approval is rejected", () => {
    expect(anyRejected([{ status: "approved" }, { status: "rejected" }])).toBe(true);
  });

  it("is false when no approval is rejected", () => {
    expect(anyRejected([{ status: "approved" }, { status: "finance_assigned" }])).toBe(false);
  });

  it("is false for an empty set", () => {
    expect(anyRejected([])).toBe(false);
  });
});
