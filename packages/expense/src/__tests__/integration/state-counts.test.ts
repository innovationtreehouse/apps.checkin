/** The flow status page's expense counts: raw org-wide totals per state. */
import { expect, it } from "vitest";
import { expenseStateCounts } from "../../services/stateCounts";
import { describeDb } from "../helpers/db";
import { seedExpense } from "../helpers/seed";

const countOf = (states: { state: string; count: number }[], state: string) => states.find((s) => s.state === state)?.count;

describeDb("expenseStateCounts", () => {
  it("is zero in every state for an org with no expenses", async () => {
    const states = await expenseStateCounts();
    expect(states.length).toBeGreaterThan(0);
    expect(states.every((s) => s.count === 0)).toBe(true);
  });

  it("counts this org's expenses per state", async () => {
    await seedExpense({ state: "qb_pending" });
    await seedExpense({ state: "qb_pending" });
    await seedExpense({ state: "qb_error" });
    await seedExpense({ state: "qb_pending", orgId: "org-2" });
    const states = await expenseStateCounts();
    expect(countOf(states, "qb_pending")).toBe(2);
    expect(countOf(states, "qb_error")).toBe(1);
    expect(countOf(states, "qb_complete")).toBe(0);
  });
});
