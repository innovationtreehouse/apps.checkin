/** `active=1` on the expense list and its count drops closed expenses; without it every expense is listed. */
import { beforeEach, expect, it } from "vitest";
import { describeDb } from "../helpers/db";
import { bindPorts, directory, principal, seedExpense } from "../helpers/seed";
import { expenses } from "../../routes";
import { CLOSED_STATES } from "../../lib/signoff";
import type { ExpenseRouteHandler } from "../../contract";

let openId: string;

function call(route: ExpenseRouteHandler, path: string) {
  return route({ req: new Request(`http://test/api/expense${path}`), params: {} });
}

describeDb("expense list active filter", () => {
  beforeEach(async () => {
    bindPorts({ auth: { getPrincipal: async () => principal(1, { isFinance: true }) }, signoff: directory({}) });
    openId = await seedExpense({ state: "owner_approval" });
    for (const state of CLOSED_STATES) await seedExpense({ state });
  });

  it("lists only open expenses with active=1", async () => {
    expect(await call(expenses.list, "/expenses?view=all&active=1")).toMatchObject({ Expense: [{ id: openId }] });
    expect(await call(expenses.count, "/expenses/count?view=all&active=1")).toEqual({ ExpenseListCount: { total: 1 } });
  });

  it("lists closed expenses too without it", async () => {
    const all = 1 + CLOSED_STATES.size;
    expect(((await call(expenses.list, "/expenses?view=all")) as { Expense: unknown[] }).Expense).toHaveLength(all);
    expect(await call(expenses.count, "/expenses/count?view=all")).toEqual({ ExpenseListCount: { total: all } });
  });
});
