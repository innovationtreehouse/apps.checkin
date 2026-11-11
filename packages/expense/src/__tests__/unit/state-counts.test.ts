import { describe, expect, it } from "vitest";
import { EXPENSE_STATES, tallyExpenseStates } from "../../services/stateCounts";

const row = (state: string, n: number) => ({ state, _count: { _all: n } });

describe("expense state tally", () => {
  it("lists every machine state, the QuickBooks states included", () => {
    expect(EXPENSE_STATES).toEqual(expect.arrayContaining(["pending", "qb_pending", "qb_on_hold", "qb_error", "qb_complete", "qb_skipped", "rejected"]));
  });

  it("shows a zero for every state when there are no expenses", () => {
    const out = tallyExpenseStates([]);
    expect(out.map((s) => s.state)).toEqual(EXPENSE_STATES);
    expect(out.every((s) => s.count === 0)).toBe(true);
  });

  it("counts present states, labels them, and keeps absent ones at zero", () => {
    const out = tallyExpenseStates([row("qb_error", 2)]);
    expect(out.find((s) => s.state === "qb_error")).toEqual({ state: "qb_error", label: "QB Error", count: 2 });
    expect(out.find((s) => s.state === "qb_complete")?.count).toBe(0);
  });

  it("labels a state with no label by its code", () => {
    expect(tallyExpenseStates([]).find((s) => s.state === "pending")?.label).toBe("pending");
  });

  it("appends a stored state the machine does not define", () => {
    expect(tallyExpenseStates([row("legacy_state", 1)]).at(-1)).toEqual({ state: "legacy_state", label: "legacy_state", count: 1 });
  });
});
