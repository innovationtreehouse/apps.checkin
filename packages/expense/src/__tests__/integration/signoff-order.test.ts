/**
 * A line's signatures in order (C′.9) against the real database: the Treasurer after the approval,
 * the Board after the Treasurer, and clearing a step clears every later one, audited, returning
 * an expense past owner approval to it with every step after owner approval cleared and done again.
 */
import { it, expect } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { bindPorts, directory, principal, seedApproval, seedExpense, seedLineItem, seedOrgSettings, seedSubmitterSeat, ORG } from "../helpers/seed";
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

    await expect(approveLine(principal(2), id, approvalId)).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/not confirmed this reimbursement yet/) });
    await seedSubmitterSeat(li, 9);
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

describeDb("going back clears every later step of the expense", () => {
  // A card charge in the QuickBooks step: a hold was raised and an outbox row written; owner 2
  // approved, 1 and 3 signed. With `capital`, its line was designated and its asset minted.
  async function postedExpense(qbMatchState = "POST_FAILED", capital = false) {
    bindPorts({ signoff: directory({ approvers: { 100: [2] }, finance: [3], board: [5] }) });
    await db.expenseOrgSettings.deleteMany();
    await seedOrgSettings({ capitalReviewEnabled: false });
    const id = await seedExpense({ state: "qb_pending", receiptTotalCents: 9000 });
    await db.expense.update({ where: { id }, data: { receiptDate: "2026-09-10", qbMatchState, qbFirstFailedAt: new Date(), qbLastError: "timeout" } });
    const li = await seedLineItem(id, { unitPriceCents: 9000, totalPriceCents: 9000, isCapital: capital, partNumber: null, manualQbAccount: "5000" });
    const approvalId = await seedApproval(id, li, { ownerId: 100, status: "approved", decidedByUserId: 2 });
    await db.expenseLineSignoff.createMany({ data: [["SUBMITTER", 1], ["TREASURER", 3]].map(([seat, signerUserId]) => ({ expenseId: id, lineItemId: li, seat: seat as string, signerUserId: signerUserId as number })) });
    if (capital) {
      await db.expenseLineItem.update({ where: { id: li }, data: { capitalOwnerId: 100, depreciationYears: 5 } });
      await db.capitalAsset.create({ data: { orgId: ORG, assetNumber: "ITFA90", description: "Lathe", status: "tracked", sourceExpenseId: id, sourceLineItemId: li, seeded: false } });
    }
    await db.expenseHold.create({ data: { orgId: ORG, expenseId: id, lineItemId: li, reason: "NO_MATCH", matchedRows: "[]" } });
    await db.expenseEvent.create({ data: { orgId: ORG, expenseId: id } });
    return { id, li, approvalId };
  }
  const reopen = (id: string, li: number) =>
    db.$transaction((tx) => clearFrom(tx, { userId: 3 }, id, [li], "APPROVAL", "finance changed the receipt"));

  it("a qb_error expense, which has no outbox row, leaves its failed step when it goes back", async () => {
    const { id, li } = await postedExpense();
    await db.expenseEvent.deleteMany({ where: { expenseId: id } });
    await db.expense.update({ where: { id }, data: { state: "qb_error", qbMatchState: "UNMATCHED" } });
    await reopen(id, li);
    expect(await db.expense.findUniqueOrThrow({ where: { id } })).toMatchObject({ state: "owner_approval", qbFirstFailedAt: null, qbLastError: null });
  });

  it("a skipped expense stays skipped when it goes back", async () => {
    const { id, li } = await postedExpense("SKIPPED");
    await reopen(id, li);
    expect(await db.expense.findUniqueOrThrow({ where: { id } })).toMatchObject({ state: "owner_approval", qbMatchState: "SKIPPED" });
    expect(await db.expenseEvent.count({ where: { expenseId: id } })).toBe(0);
  });

  it("clears the holds and outbox, audited, and the expense is approved and drains again", async () => {
    const { id, li, approvalId } = await postedExpense();
    await reopen(id, li);

    expect(await db.expense.findUniqueOrThrow({ where: { id } })).toMatchObject({ state: "owner_approval", qbMatchState: "UNMATCHED", qbFirstFailedAt: null, qbLastError: null });
    expect(await db.expenseHold.count({ where: { expenseId: id } })).toBe(0);
    expect(await db.expenseEvent.count({ where: { expenseId: id } })).toBe(0);
    const audit = await db.expenseAuditLog.findMany({ where: { expenseId: id }, orderBy: { id: "asc" } });
    expect(audit.map((a) => a.action)).toEqual(["approval_cleared", "signoff_voided", "hold_cleared", "qb_outbox_cleared", "state_transition"]);

    await approveLine(principal(2), id, approvalId);
    expect((await db.expense.findUniqueOrThrow({ where: { id } })).state).toBe("qb_pending");
  });

  it("an expense whose capital review has opened does not go back, and its assets stay", async () => {
    for (const state of ["capital_review", "set_depreciation_cycle", "qb_pending"]) {
      const { id, li } = await postedExpense("POST_FAILED", true);
      await db.expense.update({ where: { id }, data: { state } });
      await expect(reopen(id, li)).rejects.toMatchObject({ status: 409 });
      expect((await db.expense.findUniqueOrThrow({ where: { id } })).state).toBe(state);
      expect(await db.lineItemOwnerApproval.findFirstOrThrow({ where: { lineItemId: li } })).toMatchObject({ status: "approved" });
      expect(await db.capitalAsset.count({ where: { sourceExpenseId: id } })).toBe(1);
      await db.capitalAsset.deleteMany();
    }
  });

  it("an expense already in QuickBooks does not go back, and nothing is cleared", async () => {
    const { id, li } = await postedExpense("CREATED", true);
    await expect(reopen(id, li)).rejects.toMatchObject({ status: 409 });

    expect((await db.expense.findUniqueOrThrow({ where: { id } })).state).toBe("qb_pending");
    expect(await db.lineItemOwnerApproval.findFirstOrThrow({ where: { lineItemId: li } })).toMatchObject({ status: "approved" });
    expect(await db.expenseLineSignoff.count({ where: { lineItemId: li } })).toBe(2);
    expect(await db.capitalAsset.count({ where: { sourceExpenseId: id } })).toBe(1);
  });
});
