/** The list routes refuse a view the caller cannot act in, and the counts leave it out. */
import { beforeEach, describe, expect, it } from "vitest";
import { describeDb } from "../helpers/db";
import { bindPorts, directory, principal } from "../helpers/seed";
import { expenses } from "../../routes";
import type { ExpensePrincipal, ExpenseRouteHandler } from "../../contract";

// approver 2 (bucket 100) · finance 3 · board 5
const APPROVER = principal(2);
const FINANCE = principal(3, { isFinance: true });
const BOARD = principal(5, { isBoard: true });

let caller: ExpensePrincipal;

function as(p: ExpensePrincipal) {
  caller = p;
  bindPorts({ signoff: directory({ approvers: { 100: [2] }, finance: [3], board: [5] }) });
}

function call(route: ExpenseRouteHandler, path: string) {
  return route({ req: new Request(`http://test/api/expense${path}`), params: {}, principal: caller });
}

const HIDDEN: [string, ExpensePrincipal, string[]][] = [
  ["a bucket approver", APPROVER, ["assign_ownership", "resolve_ownership", "owner_exception", "capital_review", "set_depreciation_cycle", "qb_pending"]],
  ["FINANCE", FINANCE, ["awaiting_me"]],
  ["the Board", BOARD, ["assign_ownership", "resolve_ownership", "owner_exception", "capital_review", "set_depreciation_cycle"]],
];

describeDb("expense list views by role", () => {
  beforeEach(() => as(APPROVER));

  describe.each(HIDDEN)("for %s", (_name, p, hidden) => {
    beforeEach(() => as(p));

    it("refuses each view it cannot act in, on every list route", async () => {
      for (const view of hidden) {
        for (const [route, path] of [[expenses.list, "/expenses"], [expenses.count, "/expenses/count"], [expenses.queue, "/queue"]] as const) {
          await expect(call(route, `${path}?view=${view}`)).rejects.toMatchObject({ status: 403 });
        }
      }
    });

    it("leaves those views out of the counts", async () => {
      const { ExpenseCounts } = (await call(expenses.counts, "/counts")) as { ExpenseCounts: Record<string, number> };
      for (const view of hidden) expect(ExpenseCounts).not.toHaveProperty(view);
    });

    it("still lists All", async () => {
      await expect(call(expenses.list, "/expenses?view=all")).resolves.toMatchObject({ Expense: [] });
    });
  });

  it("lets a bucket approver open Waiting on you and Owner approval", async () => {
    await expect(call(expenses.list, "/expenses?view=awaiting_me")).resolves.toMatchObject({ Expense: [] });
    await expect(call(expenses.list, "/expenses?view=owner_approval")).resolves.toMatchObject({ Expense: [] });
  });
});
