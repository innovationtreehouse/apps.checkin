import { describe, expect, it } from "vitest";
import { APPLIED_LINES_LOCKED, lineLockReason } from "../../lib/line-lock";

const unstamped = { inventoryAppliedAt: null, expenseAppliedAt: null, donationAppliedAt: null };
const at = new Date("2026-10-02T00:00:00Z");

describe("lineLockReason", () => {
  it.each(["pending_review", "apply_failed"])("leaves %s lines editable while no leg has applied", (state) => {
    expect(lineLockReason({ state, ...unstamped })).toBeNull();
  });

  it.each(["inventoryAppliedAt", "expenseAppliedAt", "donationAppliedAt"])("locks apply_failed lines once %s is stamped", (stamp) => {
    expect(lineLockReason({ state: "apply_failed", ...unstamped, [stamp]: at })).toBe(APPLIED_LINES_LOCKED);
  });

  it.each(["applying", "resolved"])("locks %s lines by state", (state) => {
    expect(lineLockReason({ state, ...unstamped })).toBe(`Cannot edit lines of a receipt in state "${state}"`);
  });
});
