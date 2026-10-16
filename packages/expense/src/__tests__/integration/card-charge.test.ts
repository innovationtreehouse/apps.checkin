/** Card-charge Everyday hold and Board authorization against the real database. */
import { it, expect } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { bindPorts, directory, principal, seedApproval, seedExpense, seedLineItem, signAllLines, ORG } from "../helpers/seed";
import { markNotEveryday, recordBoardAuthorization, signoffStatus } from "../../services/signoffService";
import { unsignedLines } from "../../lib/signoff-facts";
import { checkAndProcessExpense } from "../../lib/expense-qb-processor";

const FINANCE = principal(3, { isFinance: true });

describeDb("card charges", () => {
  // purchaser 1 · leader 2 · finance 3 and 4 · board 5 · 8 in the purchaser's household
  async function signedCard(opts: { receiptTotalCents?: number; unitPriceCents?: number } = {}) {
    bindPorts({ signoff: directory({ approvers: { 100: [2] }, finance: [3, 4], board: [5], households: [[1, 8]] }) });
    const id = await seedExpense({ state: "qb_pending", receiptTotalCents: opts.receiptTotalCents ?? 100 });
    const li = await seedLineItem(id, { partNumber: null, manualQbAccount: "5000", unitPriceCents: opts.unitPriceCents ?? 100 });
    await seedApproval(id, li, { ownerId: 100, status: "approved" });
    await signAllLines(id);
    await db.expense.update({ where: { id }, data: { boardAuthorization: null } });
    return id;
  }
  const holds = async (id: string) => [...(await unsignedLines(db, (await db.expense.findUnique({ where: { id } }))!)).values()].flat();
  const events = (id: string) => db.expenseEvent.count({ where: { expenseId: id } });

  it("an Everyday card charge with every seat signed is not held", async () => {
    expect(await holds(await signedCard())).toEqual([]);
  });

  it("a non-Everyday card charge is held until the Treasurer records the Board authorization, then drains", async () => {
    const id = await signedCard({ receiptTotalCents: 50_000 });
    await checkAndProcessExpense(ORG, id);
    expect(await holds(id)).toEqual(["BOARD_AUTHORIZATION"]);
    expect((await signoffStatus(id))[0].missing).toEqual(["BOARD_AUTHORIZATION"]);
    expect(await events(id)).toBe(0);

    await expect(recordBoardAuthorization(FINANCE, id, "  ")).rejects.toMatchObject({ statusCode: 400 });
    await recordBoardAuthorization(FINANCE, id, "Board minutes 2026-10-01, item 4");

    expect(await events(id)).toBe(1);
    const row = (await db.expense.findUnique({ where: { id } }))!;
    expect([row.boardAuthorization, row.boardAuthorizedByUserId]).toEqual(["Board minutes 2026-10-01, item 4", 3]);
  });

  it("an item over the item limit holds it", async () => {
    expect(await holds(await signedCard({ receiptTotalCents: 25_001, unitPriceCents: 25_001 }))).toEqual(["BOARD_AUTHORIZATION"]);
  });

  it("FINANCE marks it single-source or not Everyday, one-way; nobody else can", async () => {
    const id = await signedCard();
    await expect(markNotEveryday(principal(5, { isBoard: true }), id, "single_source")).rejects.toMatchObject({ statusCode: 403 });
    await markNotEveryday(FINANCE, id, "single_source");
    expect(await holds(id)).toEqual(["BOARD_AUTHORIZATION"]);

    const other = await signedCard();
    await markNotEveryday(FINANCE, other, "finance_override");
    expect(await holds(other)).toEqual(["BOARD_AUTHORIZATION"]);
    const audit = await db.expenseAuditLog.findMany({ where: { expenseId: other, action: "not_everyday_marked" } });
    expect(audit.map((a) => [a.userId, a.fieldChanged])).toEqual([[3, "financeNotEveryday"]]);
  });

  it("a conflicted Treasurer cannot record the authorization; another FINANCE holder does", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [2] }, finance: [3, 4], board: [5], households: [[1, 3]] }) });
    const id = await seedExpense({ state: "qb_pending", receiptTotalCents: 60_000 });
    await seedLineItem(id, { partNumber: null, manualQbAccount: "5000" });
    await expect(recordBoardAuthorization(FINANCE, id, "Board vote")).rejects.toMatchObject({ statusCode: 403 });
    await recordBoardAuthorization(principal(4, { isFinance: true }), id, "Board vote");
    await expect(recordBoardAuthorization(principal(4, { isFinance: true }), id, "again")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("a Board member records it only when every FINANCE holder is conflicted, and that raises a COI flag", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [2] }, finance: [3], board: [5], households: [[1, 3]] }) });
    const id = await seedExpense({ receiptTotalCents: 60_000 });
    await seedLineItem(id, { partNumber: null, manualQbAccount: "5000" });
    await recordBoardAuthorization(principal(5, { isBoard: true }), id, "Board vote");
    const flags = await db.expenseFlag.findMany({ where: { expenseId: id } });
    expect(flags.map((f) => [f.kind, f.audience])).toEqual([["COI", "BOARD"]]);
  });

  it("a FINANCE holder recording it raises no flag", async () => {
    const id = await signedCard({ receiptTotalCents: 60_000 });
    await recordBoardAuthorization(FINANCE, id, "Board vote");
    expect(await db.expenseFlag.count({ where: { expenseId: id, kind: "COI" } })).toBe(0);
  });

  it("a reimbursement takes no Board authorization", async () => {
    bindPorts({ signoff: directory({ finance: [3] }) });
    const id = await seedExpense({ needsReimbursement: true, reimburseePersonId: 1 });
    await expect(recordBoardAuthorization(FINANCE, id, "x")).rejects.toMatchObject({ statusCode: 400 });
  });
});
