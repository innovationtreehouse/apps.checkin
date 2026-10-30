import { describe, expect, it } from "vitest";
import { expenseOutcomeOf } from "../../services/expenseOutcomes";

const base = { state: "owner_approval", backfill: false, needsReimbursement: false, approvals: [], unconfirmedLines: 0 };

describe("an expense's outcome for its uploader", () => {
  it("a rejected expense is a rejected line, carrying each rejected line's note and no other", () => {
    const approvals = [
      { status: "rejected", notes: " Not a program cost " },
      { status: "approved", notes: "fine" },
      { status: "rejected", notes: null },
    ];
    expect(expenseOutcomeOf({ ...base, state: "rejected", approvals })).toEqual({ status: "line_rejected", notes: ["Not a program cost"] });
  });

  it("waits on approval, then on finance, then completes", () => {
    expect(expenseOutcomeOf({ ...base, state: "assign_ownership" }).status).toBe("awaiting_approval");
    expect(expenseOutcomeOf(base).status).toBe("awaiting_approval");
    expect(expenseOutcomeOf({ ...base, state: "qb_on_hold" }).status).toBe("with_finance");
    expect(expenseOutcomeOf({ ...base, state: "qb_complete" })).toEqual({ status: "complete", notes: [] });
    expect(expenseOutcomeOf({ ...base, state: "qb_skipped", backfill: true }).status).toBe("backfill");
  });

  it("an exception on a line reads as a question, without the approver's note", () => {
    expect(expenseOutcomeOf({ ...base, approvals: [{ status: "exception_raised", notes: "Wrong bucket" }] })).toEqual({ status: "exception", notes: [] });
  });

  it("a reimbursement whose confirmation was cleared waits for it before anything else", () => {
    expect(expenseOutcomeOf({ ...base, needsReimbursement: true, unconfirmedLines: 2 }).status).toBe("awaiting_confirmation");
    expect(expenseOutcomeOf({ ...base, needsReimbursement: true, backfill: true, unconfirmedLines: 2 }).status).toBe("awaiting_approval");
  });
});
