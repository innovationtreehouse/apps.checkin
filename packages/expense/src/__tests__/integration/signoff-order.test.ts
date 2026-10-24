/**
 * A line's signatures in order (C′.9) against the real database: the Treasurer after the approval,
 * the Board after the Treasurer, and clearing a step clears every later one, audited, returning
 * an expense past owner approval to it.
 */
import { it, expect } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { bindPorts, directory, principal, seedApproval, seedExpense, seedLineItem } from "../helpers/seed";
import { signLine } from "../../services/signoffService";
import { approveLine } from "../../services/approvalService";
import { clearFrom, type ClearedStep } from "../../lib/signoff-facts";

const FINANCE = principal(3, { isFinance: true });
const BOARD = principal(5, { isBoard: true });

describeDb("signatures in order", () => {
  it("the Treasurer waits for the approval, and the Board for the Treasurer", async () => {
    // A non-Everyday org-level card charge takes the Board seat; 6 is the Board member who approves it.
    bindPorts({ signoff: directory({ orgLevel: [7], finance: [3], board: [5, 6] }) });
    const id = await seedExpense({ state: "owner_approval", receiptTotalCents: 60_000 });
    const li = await seedLineItem(id, { partNumber: null, manualQbAccount: "5000" });
    const approvalId = await seedApproval(id, li, { ownerId: 7 });

    await expect(signLine(FINANCE, li, "TREASURER")).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/not approved yet/) });
    await expect(signLine(BOARD, li, "BOARD")).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/not approved yet/) });

    await approveLine(principal(6, { isBoard: true }), id, approvalId);
    await expect(signLine(BOARD, li, "BOARD")).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/after the Treasurer/) });
    await signLine(FINANCE, li, "TREASURER");
    await signLine(BOARD, li, "BOARD");

    const seats = await db.expenseLineSignoff.findMany({ where: { lineItemId: li }, orderBy: { id: "asc" } });
    expect(seats.map((s) => s.seat)).toEqual(["TREASURER", "BOARD"]);
  });

  it("a card charge takes no submitter seat: the Treasurer's signature after the approval posts it", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [2] }, finance: [3] }) });
    const id = await seedExpense({ state: "qb_pending" });
    const li = await seedLineItem(id, { partNumber: null, manualQbAccount: "5000" });
    await seedApproval(id, li, { ownerId: 100, status: "approved", decidedByUserId: 2 });

    await expect(signLine(principal(1), li, "SUBMITTER")).rejects.toMatchObject({ status: 403 });
    await signLine(FINANCE, li, "TREASURER");
    expect(await db.expenseEvent.count({ where: { expenseId: id } })).toBe(1);
  });

  it("a reimbursement's line is approved only after the person reimbursed confirms", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [2] }, finance: [3] }) });
    const id = await seedExpense({ state: "owner_approval", needsReimbursement: true, reimburseePersonId: 9 });
    const li = await seedLineItem(id, { partNumber: null, manualQbAccount: "5000" });
    const approvalId = await seedApproval(id, li, { ownerId: 100 });

    await expect(approveLine(principal(2), id, approvalId)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/not confirmed yet/) });
    await signLine(principal(9), li, "SUBMITTER");
    await approveLine(principal(2), id, approvalId);
  });
});

describeDb("clearing a step clears every later one", () => {
  // A non-member reimbursement: submitter 1 is reimbursed and not a member, so the line takes the
  // Board seat; owner 2 approved, 3 signed as Treasurer, 5 for the Board. Two lines; only `a` is cleared.
  async function signedLine(state = "qb_pending") {
    bindPorts({ signoff: directory({ approvers: { 100: [2] }, finance: [3], board: [5], nonMembers: [1] }) });
    const id = await seedExpense({ state, needsReimbursement: true, reimburseePersonId: 1 });
    await db.expense.update({ where: { id }, data: { boardAuthorization: "Board minutes, item 2" } });
    const [a, b] = [await seedLineItem(id), await seedLineItem(id)];
    for (const li of [a, b]) {
      await seedApproval(id, li, { ownerId: 100, status: "approved", decidedByUserId: 2 });
      await db.expenseLineSignoff.createMany({
        data: [["SUBMITTER", 1], ["TREASURER", 3], ["BOARD", 5]].map(([seat, signerUserId]) => ({ expenseId: id, lineItemId: li, seat: seat as string, signerUserId: signerUserId as number })),
      });
      await db.expenseLineItem.update({ where: { id: li }, data: { signedGtin13: "0000000000017", signedCategory: "Hardware" } });
    }
    return { id, a, b };
  }
  const clear = (id: string, li: number, from: ClearedStep) =>
    db.$transaction((tx) => clearFrom(tx, { userId: 3, username: "fin" }, id, [li], from, "finance changed the receipt"));
  const seatsOf = async (li: number) => (await db.expenseLineSignoff.findMany({ where: { lineItemId: li }, orderBy: { id: "asc" } })).map((s) => s.seat);
  const approvalOf = (li: number) => db.lineItemOwnerApproval.findFirstOrThrow({ where: { lineItemId: li } });
  const stateOf = async (id: string) => (await db.expense.findUniqueOrThrow({ where: { id } })).state;

  it("clearing the submitter seat reopens the approval and deletes the Treasurer and Board seats", async () => {
    const { id, a, b } = await signedLine();
    await clear(id, a, "SUBMITTER");

    expect(await seatsOf(a)).toEqual([]);
    expect(await approvalOf(a)).toMatchObject({ status: "pending", decidedByUserId: null, decidedAt: null });
    expect(await seatsOf(b)).toEqual(["SUBMITTER", "TREASURER", "BOARD"]);
    expect(await approvalOf(b)).toMatchObject({ status: "approved", decidedByUserId: 2 });
  });

  it("reopening an approval keeps the submitter seat, deletes the later seats, and audits each one", async () => {
    const { id, a } = await signedLine();
    await clear(id, a, "APPROVAL");

    expect(await seatsOf(a)).toEqual(["SUBMITTER"]);
    expect(await approvalOf(a)).toMatchObject({ status: "pending" });
    const audit = await db.expenseAuditLog.findMany({ where: { expenseId: id, lineItemId: a }, orderBy: { id: "asc" } });
    expect(audit.map((r) => [r.action, r.valueBefore, r.notes])).toEqual([
      ["approval_cleared", "approved", "approver 2: finance changed the receipt"],
      ["signoff_voided", "TREASURER", "signer 3: finance changed the receipt"],
      ["signoff_voided", "BOARD", "signer 5: finance changed the receipt"],
    ]);
    expect(await db.expenseLineItem.findUniqueOrThrow({ where: { id: a } })).toMatchObject({ signedGtin13: null, signedCategory: null });
  });

  it("an expense past owner approval returns to it, and the Board's recorded authorization stays", async () => {
    const { id, a } = await signedLine("qb_on_hold");
    await clear(id, a, "APPROVAL");

    expect(await stateOf(id)).toBe("owner_approval");
    const moved = await db.expenseAuditLog.findFirstOrThrow({ where: { expenseId: id, action: "state_transition" } });
    expect(moved).toMatchObject({ valueBefore: "qb_on_hold", valueAfter: "owner_approval", notes: "finance changed the receipt" });
    expect((await db.expense.findUniqueOrThrow({ where: { id } })).boardAuthorization).toBe("Board minutes, item 2");
  });

  it("an expense in owner approval stays there", async () => {
    const { id, a } = await signedLine("owner_approval");
    await clear(id, a, "APPROVAL");
    expect(await stateOf(id)).toBe("owner_approval");
  });

  it("clearing the Treasurer seat deletes the Board seat and leaves the approval and the state", async () => {
    const { id, a } = await signedLine();
    await clear(id, a, "TREASURER");

    expect(await seatsOf(a)).toEqual(["SUBMITTER"]);
    expect(await approvalOf(a)).toMatchObject({ status: "approved", decidedByUserId: 2 });
    expect(await stateOf(id)).toBe("qb_pending");
  });

  it("after a reopened approval, the line is approved and signed again in order", async () => {
    const { id, a } = await signedLine();
    await clear(id, a, "APPROVAL");

    await expect(signLine(FINANCE, a, "TREASURER")).rejects.toMatchObject({ status: 403 });
    await approveLine(principal(2), id, (await approvalOf(a)).id);
    await signLine(FINANCE, a, "TREASURER");
    await signLine(BOARD, a, "BOARD");
    expect(await seatsOf(a)).toEqual(["SUBMITTER", "TREASURER", "BOARD"]);
  });
});
