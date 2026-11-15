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
import { expenseMachine } from "../../workflows/expense.machine";

const on = { capitalReviewEnabled: true, capitalTotalThresholdCents: 500_000, capitalLineItemThresholdCents: 250_000 };

describe("classifyCapital", () => {
  it("is capital at or over a threshold, and not below it", () => {
    expect(classifyCapital(500_000, [], on)).toBe(true);
    expect(classifyCapital(0, [{ unitPriceCents: 250_000 }], on)).toBe(true);
    expect(classifyCapital(499_999, [{ unitPriceCents: 249_999 }], on)).toBe(false);
  });

  it("sends nothing to capital review while review is off", () => {
    expect(classifyCapital(1_000_000, [{ unitPriceCents: 1_000_000 }], { ...on, capitalReviewEnabled: false })).toBe(false);
  });

  it.each([
    { capitalTotalThresholdCents: null },
    { capitalLineItemThresholdCents: null },
  ])("holds every expense at capital_review while review is on and a threshold is unset (%o)", (unset) => {
    const settings = { ...on, ...unset };
    expect(capitalThresholdsUnset(settings)).toBe(true);
    const hasCapital = classifyCapital(1, [{ unitPriceCents: 1 }], settings);
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
