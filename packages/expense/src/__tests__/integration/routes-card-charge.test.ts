/** The card-charge sign-off route factories against the real database. */
import { expect, it } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { bindPorts, directory, principal, seedExpense, seedLineItem } from "../helpers/seed";
import { expenses } from "../../routes";
import type { ExpensePrincipal, ExpenseRouteHandler } from "../../contract";

// purchaser 1 · leader 2 · finance 3 and 4 · board 5
const FINANCE = principal(3, { isFinance: true });
const BOARD = principal(5, { isBoard: true });

function as(who: ExpensePrincipal, households: number[][] = []) {
  bindPorts({
    auth: { getPrincipal: async () => who },
    signoff: directory({ approvers: { 100: [2] }, finance: [3, 4], board: [5], households }),
  });
}

function call(route: ExpenseRouteHandler, id: string, body: unknown) {
  const req = new Request(`http://test/api/expense/expenses/${id}/x`, { method: "POST", body: JSON.stringify(body) });
  return route({ req, params: { id } });
}

async function cardCharge() {
  const id = await seedExpense({ state: "qb_pending", receiptTotalCents: 60_000 });
  await seedLineItem(id, { partNumber: null, manualQbAccount: "5000" });
  return id;
}

describeDb("card-charge sign-off routes", () => {
  it("board-authorization records the text and returns every line's status", async () => {
    as(FINANCE);
    const id = await cardCharge();
    const res = (await call(expenses.boardAuthorization, id, { authorization: "  Board vote, 2026-10-01 " })) as {
      ExpenseLineSignoffStatus: { missing: string[] }[];
    };
    expect(res.ExpenseLineSignoffStatus).toHaveLength(1);
    expect(res.ExpenseLineSignoffStatus[0].missing).not.toContain("BOARD_AUTHORIZATION");
    expect((await db.expense.findUnique({ where: { id } }))?.boardAuthorization).toBe("Board vote, 2026-10-01");
  });

  it("board-authorization refuses blank text with 400", async () => {
    as(FINANCE);
    const id = await cardCharge();
    await expect(call(expenses.boardAuthorization, id, { authorization: "   " })).rejects.toMatchObject({ status: 400 });
    await expect(call(expenses.boardAuthorization, id, {})).rejects.toMatchObject({ status: 400 });
    expect((await db.expense.findUnique({ where: { id } }))?.boardAuthorization).toBeNull();
  });

  it("board-authorization refuses a conflicted recorder with 403", async () => {
    as(FINANCE, [[1, 3]]);
    const id = await cardCharge();
    await expect(call(expenses.boardAuthorization, id, { authorization: "Board vote" })).rejects.toMatchObject({ status: 403 });
  });

  it("board-authorization refuses a Board member while a FINANCE holder without a conflict exists", async () => {
    as(BOARD);
    const id = await cardCharge();
    await expect(call(expenses.boardAuthorization, id, { authorization: "Board vote" })).rejects.toMatchObject({ status: 403 });
  });

  it("board-authorization refuses a second record with 409", async () => {
    as(FINANCE);
    const id = await cardCharge();
    await call(expenses.boardAuthorization, id, { authorization: "Board vote" });
    await expect(call(expenses.boardAuthorization, id, { authorization: "again" })).rejects.toMatchObject({ status: 409 });
  });
});
