/** The finance writes that name a QuickBooks account refuse an id QuickBooks cannot hold, before any database read. */
import { describe, expect, it } from "vitest";
import type { ExpensePrincipal, ExpenseRouteHandler } from "../../contract";
import { createAccountMapping, createQbAccount, holdLineAccount, updateAccountMapping, updateQbAccount } from "../../routes/finance";

const FINANCE: ExpensePrincipal = { id: 1, name: "Finance", isFinance: true, isBoard: false };
const RULE = { category: "Lumber", subcategory: "Plywood", partNumber: "*", isDelayed: null, isCapital: null };

function call(handler: ExpenseRouteHandler, body: unknown, params: Record<string, string> = {}) {
  const req = new Request("http://test/", { method: "POST", body: JSON.stringify(body) });
  return handler({ req, params, principal: FINANCE });
}

describe("QuickBooks account ids on finance writes", () => {
  it.each([
    ["a held line's account", holdLineAccount, (qbAccount: string) => ({ qbAccount }), { expenseId: "e1", lineItemId: "3" }],
    ["a new mapping rule", createAccountMapping, (qbAccount: string) => ({ ...RULE, qbAccount }), {}],
    ["an edited mapping rule", updateAccountMapping, (qbAccount: string) => ({ ...RULE, qbAccount }), { id: "4" }],
    ["a new list account", createQbAccount, (qbAccount: string) => ({ name: "Supplies", qbAccount }), {}],
    ["an edited list account", updateQbAccount, (qbAccount: string) => ({ name: "Supplies", qbAccount }), { id: "4" }],
  ])("%s naming a non-numeric id is a 400", async (_case, handler, body, params) => {
    await expect(call(handler, body("6010 Supplies"), params)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/digits only/) });
  });
});
