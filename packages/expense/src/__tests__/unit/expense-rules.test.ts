/**
 * Unit coverage for capital classification, approval terminal classification and the reject helper.
 *
 * The auto-transition (checkApprovalAutoTransition) fires once every approval is
 * terminal; "rejected" is terminal-but-non-proceeding and refuses the whole
 * expense via anyRejected.
 */
import { describe, it, expect } from "vitest";
import { createActor } from "xstate";
import { classifyCapital, isTerminalApproval, anyRejected } from "../../lib/expense-rules";
import { expenseMachine } from "../../workflows/expense.machine";

const zeroThresholds = { capitalTotalThresholdCents: 0, capitalLineItemThresholdCents: 0 };

describe("classifyCapital", () => {
  it("with both thresholds at 0, any positive total is capital and reaches capital_review", () => {
    const hasCapital = classifyCapital(1, [{ unitPriceCents: 0 }], zeroThresholds);
    expect(hasCapital).toBe(true);

    const actor = createActor(expenseMachine).start();
    actor.send({ type: "FLOW_STARTED", allOwnersResolved: true });
    actor.send({ type: "ALL_APPROVALS_TERMINAL", hasCapital, anyRejected: false });
    expect(actor.getSnapshot().value).toBe("capital_review");
    actor.stop();
  });

  it("with both thresholds at 0, a zero total with no priced line is not capital", () => {
    expect(classifyCapital(0, [{ unitPriceCents: 0 }], zeroThresholds)).toBe(false);
  });

  it("is capital only above a threshold, never at it", () => {
    const org = { capitalTotalThresholdCents: 500_000, capitalLineItemThresholdCents: 250_000 };
    expect(classifyCapital(500_000, [{ unitPriceCents: 250_000 }], org)).toBe(false);
    expect(classifyCapital(500_001, [], org)).toBe(true);
    expect(classifyCapital(0, [{ unitPriceCents: 250_001 }], org)).toBe(true);
  });

  it("is not capital without org settings", () => {
    expect(classifyCapital(1_000_000, [{ unitPriceCents: 1_000_000 }], null)).toBe(false);
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
