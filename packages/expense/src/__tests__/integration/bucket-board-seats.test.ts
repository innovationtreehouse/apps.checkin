/**
 * Which open lines in an org-level bucket still wait on a Board signature, against the real
 * database: the check that refuses making the bucket a program bucket while one is open.
 */
import { it, expect, beforeEach } from "vitest";
import { db } from "../../db";
import { describeDb } from "../helpers/db";
import { bindPorts, directory, principal, seedApproval, seedExpense, seedLineItem } from "../helpers/seed";
import { linesAwaitingBoardSeat, signLine } from "../../services/signoffService";
import { approveLine } from "../../services/approvalService";

const NOT_EVERYDAY = 60_000;

describeDb("lines awaiting a Board seat in an org-level bucket", () => {
  beforeEach(() => bindPorts({ signoff: directory({ orgLevel: [7], approvers: { 100: [2] }, finance: [3], board: [5, 6] }) }));

  async function charge(opts: Parameters<typeof seedExpense>[0] = {}, bucket = 7) {
    const id = await seedExpense({ state: "owner_approval", receiptTotalCents: NOT_EVERYDAY, ...opts });
    const lineItemId = await seedLineItem(id);
    return { id, lineItemId, approvalId: await seedApproval(id, lineItemId, { ownerId: bucket }) };
  }

  it("counts a non-Everyday card charge before its approval", async () => {
    await charge();
    expect(await linesAwaitingBoardSeat(7)).toBe(1);
  });

  it("counts an approved, Treasurer-signed line whose Board seat is unsigned", async () => {
    const { id, lineItemId, approvalId } = await charge();
    await approveLine(principal(6, { isBoard: true }), id, approvalId);
    await signLine(principal(3, { isFinance: true }), lineItemId, "TREASURER");
    expect(await linesAwaitingBoardSeat(7)).toBe(1);
  });

  it("counts a line in an expense at qb_pending", async () => {
    await charge({ state: "qb_pending" });
    expect(await linesAwaitingBoardSeat(7)).toBe(1);
  });

  it("does not count a line whose Board seat is signed", async () => {
    const { id, lineItemId, approvalId } = await charge();
    await approveLine(principal(6, { isBoard: true }), id, approvalId);
    await signLine(principal(3, { isFinance: true }), lineItemId, "TREASURER");
    await signLine(principal(5, { isBoard: true }), lineItemId, "BOARD");
    expect(await linesAwaitingBoardSeat(7)).toBe(0);
  });

  it("does not count a line once a Board authorization is recorded", async () => {
    const { id } = await charge();
    await db.expense.update({ where: { id }, data: { boardAuthorization: "Board minutes, October" } });
    expect(await linesAwaitingBoardSeat(7)).toBe(0);
  });

  it.each([
    ["an Everyday charge", { receiptTotalCents: 100 }],
    ["a reimbursement", { needsReimbursement: true, reimburseePersonId: 1 }],
    ["a closed expense", { state: "qb_complete" }],
    ["a backfill", { backfill: true }],
  ])("does not count %s", async (_name, opts) => {
    await charge(opts);
    expect(await linesAwaitingBoardSeat(7)).toBe(0);
  });

  it("does not count another bucket's line", async () => {
    await charge({}, 100);
    expect(await linesAwaitingBoardSeat(7)).toBe(0);
  });
});
