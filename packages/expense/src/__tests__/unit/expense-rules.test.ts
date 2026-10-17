/**
 * Unit coverage for approval terminal classification and the reject helper.
 *
 * The auto-transition (checkApprovalAutoTransition) fires once every approval is
 * terminal; "rejected" is terminal-but-non-proceeding and refuses the whole
 * expense via anyRejected.
 */
import { describe, it, expect } from "vitest";
import { isTerminalApproval, anyRejected } from "../../lib/expense-rules";

describe("isTerminalApproval", () => {
  it("treats decided statuses as terminal", () => {
    expect(isTerminalApproval("approved")).toBe(true);
    expect(isTerminalApproval("finance_assigned")).toBe(true);
    expect(isTerminalApproval("rejected")).toBe(true);
  });

  it("treats undecided statuses as non-terminal", () => {
    expect(isTerminalApproval("pending")).toBe(false);
    expect(isTerminalApproval("exception_raised")).toBe(false);
    expect(isTerminalApproval("unknown")).toBe(false);
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
