/** Which expense list views each role sees: only those it can act in. Pure — no database. */
import { describe, expect, it } from "vitest";
import { expenseViewsFor, type ExpenseViewer } from "../../nav";

const NONE: ExpenseViewer = { approver: false, isFinance: false, isBoard: false };
const FINANCE_VIEWS = ["assign_ownership", "resolve_ownership", "owner_exception", "capital_review", "set_depreciation_cycle"];

describe("expenseViewsFor", () => {
  it("gives a bucket approver who holds no role only All, Waiting on you and Owner approval", () => {
    expect(expenseViewsFor({ ...NONE, approver: true })).toEqual(["all", "awaiting_me", "owner_approval"]);
  });

  it("gives FINANCE the bucket and bookkeeping views, Owner approval for exceptions, and QB pending, but not Waiting on you", () => {
    expect(expenseViewsFor({ ...NONE, isFinance: true })).toEqual(["all", "assign_ownership", "resolve_ownership", "owner_approval", "owner_exception", "capital_review", "set_depreciation_cycle", "qb_pending"]);
  });

  it("gives the Board approval views and QB pending, and no FINANCE view", () => {
    const views = expenseViewsFor({ ...NONE, isBoard: true });
    expect(views).toEqual(["all", "awaiting_me", "owner_approval", "qb_pending"]);
    for (const v of FINANCE_VIEWS) expect(views).not.toContain(v);
  });

  it("gives a FINANCE holder who approves a bucket every view", () => {
    expect(expenseViewsFor({ ...NONE, approver: true, isFinance: true })).toHaveLength(9);
  });

  it("gives someone with no role only All", () => {
    expect(expenseViewsFor(NONE)).toEqual(["all"]);
  });
});
