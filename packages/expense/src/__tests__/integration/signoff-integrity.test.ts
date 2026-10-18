/**
 * Integrity of the sign-off chain against the real database: seats tied to the line's bucket and
 * payee, valid buckets, independent flag check-offs, serialized sign-offs, and the payee carried
 * into the outbox.
 */
import { it, expect } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { bindPorts, directory, principal, seedApproval, seedExpense, seedLineItem, signAllLines, ORG } from "../helpers/seed";
import { setReimbursee, signLine } from "../../services/signoffService";
import { assignOwner, financeAssign, raiseException, resolveUnknown } from "../../services/approvalService";
import { checkOffFlag, raiseFlag } from "../../services/flagService";
import { checkAndProcessExpense } from "../../lib/expense-qb-processor";
import { updateExpenseSettings } from "../../services/settingsService";

const FINANCE = principal(3, { isFinance: true });
const BOARD = principal(5, { isBoard: true });
const seatsOf = async (lineItemId: number) =>
  (await db.expenseLineSignoff.findMany({ where: { lineItemId }, orderBy: { id: "asc" } })).map((s) => [s.seat, s.signerUserId]);

describeDb("seats follow the line's bucket", () => {
  it("nobody signs as program approver before the line has a bucket, not even the Board", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [2] }, finance: [3], board: [5] }) });
    const id = await seedExpense({ state: "assign_ownership" });
    const li = await seedLineItem(id);
    await seedApproval(id, li, { ownerId: null });

    await expect(signLine(BOARD, li, "PROGRAM_APPROVER")).rejects.toMatchObject({ status: 409 });
    expect(await seatsOf(li)).toEqual([]);
  });

  it("moving a line to another bucket voids its sign-offs, except the submitter's", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [2], 101: [4] }, finance: [3], board: [5] }) });
    const id = await seedExpense({ state: "owner_approval" });
    const li = await seedLineItem(id);
    const approvalId = await seedApproval(id, li, { ownerId: 100 });
    await signLine(principal(1), li, "SUBMITTER");
    await signLine(principal(2), li, "PROGRAM_APPROVER");

    await raiseException(principal(2), id, approvalId, "not ours");
    await financeAssign(FINANCE, id, approvalId, 101);

    expect(await seatsOf(li)).toEqual([["SUBMITTER", 1]]);
    const voided = await db.expenseAuditLog.findMany({ where: { expenseId: id, action: "signoff_voided" } });
    expect(voided.map((a) => [a.lineItemId, a.valueBefore])).toEqual([[li, "PROGRAM_APPROVER"]]);
    await expect(signLine(principal(2), li, "PROGRAM_APPROVER")).rejects.toMatchObject({ status: 403 });
    await signLine(principal(4), li, "PROGRAM_APPROVER");
  });
});

describeDb("a line is assigned only to a live bucket", () => {
  it("FINANCE cannot assign an unknown or archived bucket", async () => {
    const id = await seedExpense({ state: "assign_ownership" });
    const li = await seedLineItem(id);
    const approvalId = await seedApproval(id, li, { ownerId: null });
    await expect(assignOwner(FINANCE, id, approvalId, 555)).rejects.toMatchObject({ status: 400 });
    await expect(assignOwner(FINANCE, id, approvalId, 999)).rejects.toMatchObject({ status: 400 });

    const unknown = await seedApproval(id, await seedLineItem(id), { ownerId: null, status: "unknown" });
    await expect(resolveUnknown(FINANCE, id, unknown, 555)).rejects.toMatchObject({ status: 400 });

    const flow = await seedExpense({ state: "owner_approval" });
    const exception = await seedApproval(flow, await seedLineItem(flow), { ownerId: 100, status: "exception_raised" });
    await expect(financeAssign(FINANCE, flow, exception, 999)).rejects.toMatchObject({ status: 400 });

    expect((await db.lineItemOwnerApproval.findFirst({ where: { id: approvalId } }))!.ownerId).toBeNull();
  });
});

describeDb("seats follow the payee", () => {
  it("a known reimbursee cannot be changed, and its seats stand", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [2] }, finance: [3, 4], board: [5] }) });
    const id = await seedExpense({ state: "owner_approval", needsReimbursement: true, reimburseePersonId: 7 });
    const li = await seedLineItem(id);
    await seedApproval(id, li, { ownerId: 100 });
    await signLine(principal(1), li, "SUBMITTER");
    await signLine(principal(2), li, "PROGRAM_APPROVER");
    await signLine(FINANCE, li, "TREASURER");

    await expect(setReimbursee(ORG, id, 9, principal(4, { isFinance: true }))).rejects.toMatchObject({ status: 409 });

    expect((await db.expense.findFirst({ where: { id } }))!.reimburseePersonId).toBe(7);
    expect(await seatsOf(li)).toEqual([["SUBMITTER", 1], ["PROGRAM_APPROVER", 2], ["TREASURER", 3]]);
    expect(await db.expenseAuditLog.count({ where: { expenseId: id, action: "reimbursee_set" } })).toBe(0);
  });

  it("two FINANCE holders naming a reimbursee at once: one wins, the other is refused", async () => {
    bindPorts({ signoff: directory({ finance: [3, 4] }) });
    const id = await seedExpense({ state: "owner_approval", needsReimbursement: true });

    const results = await Promise.allSettled([setReimbursee(ORG, id, 1, FINANCE), setReimbursee(ORG, id, 1, principal(4, { isFinance: true }))]);

    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { status: 409 } });
    expect(await db.expenseAuditLog.count({ where: { expenseId: id, action: "reimbursee_set" } })).toBe(1);
  });

  it("whoever named the reimbursee cannot sign as Treasurer; another FINANCE holder can", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [2] }, finance: [3, 4], board: [5] }) });
    const id = await seedExpense({ state: "qb_pending", needsReimbursement: true });
    await db.expense.update({ where: { id }, data: { reimbursementFor: "Pat" } });
    const li = await seedLineItem(id, { partNumber: null, manualQbAccount: "5000" });
    await seedApproval(id, li, { ownerId: 100, status: "approved" });

    await setReimbursee(ORG, id, 1, FINANCE);
    expect((await db.expense.findFirst({ where: { id } }))!.reimbursementFor).toBe("Pat");
    await signLine(principal(1), li, "SUBMITTER");
    await signLine(principal(2), li, "PROGRAM_APPROVER");

    await expect(signLine(FINANCE, li, "TREASURER")).rejects.toMatchObject({ status: 403 });
    await signLine(principal(4, { isFinance: true }), li, "TREASURER");
    expect(await db.expenseEvent.count({ where: { expenseId: id } })).toBe(1);
  });

  it("the only FINANCE holder named the reimbursee: a Board member takes the Treasurer seat", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [2] }, finance: [3], board: [3, 5] }) });
    const id = await seedExpense({ state: "owner_approval", needsReimbursement: true });
    const li = await seedLineItem(id);
    await seedApproval(id, li, { ownerId: 100 });

    await setReimbursee(ORG, id, 1, FINANCE);

    await expect(signLine(principal(3, { isFinance: true, isBoard: true }), li, "TREASURER")).rejects.toMatchObject({ status: 403 });
    await signLine(BOARD, li, "TREASURER");
  });

  it("the outbox event names the reimbursee the seats were signed for", async () => {
    const id = await seedExpense({ state: "qb_pending", needsReimbursement: true, reimburseePersonId: 9 });
    const li = await seedLineItem(id, { partNumber: null, manualQbAccount: "5000" });
    await seedApproval(id, li, { ownerId: 100, status: "approved" });
    await signAllLines(id);

    await checkAndProcessExpense(ORG, id);

    const [event] = await db.expenseEvent.findMany({ where: { expenseId: id } });
    expect(JSON.parse(event.payload)).toMatchObject({ needsReimbursement: true, reimburseePersonId: 9 });
  });
});

describeDb("flags are checked off independently", () => {
  it("a party to the expense, or their household, cannot check off its flags", async () => {
    bindPorts({ signoff: directory({ households: [[1, 6]] }) });
    const id = await seedExpense({ submitterId: 1 });
    await raiseFlag(id, "COI", "conflict");
    const flag = (await db.expenseFlag.findFirst({ where: { expenseId: id } }))!;

    await expect(checkOffFlag(principal(1, { isBoard: true }), flag.id)).rejects.toMatchObject({ status: 403 });
    await expect(checkOffFlag(principal(6, { isBoard: true }), flag.id)).rejects.toMatchObject({ status: 403 });
    await checkOffFlag(BOARD, flag.id);
  });
});

describeDb("threshold changes", () => {
  it("FINANCE tightens and loosens within policy; past policy, or switching review off, is the Board's", async () => {
    await expect(updateExpenseSettings(ORG, { boardReviewTotalCents: 250_000 }, FINANCE)).rejects.toMatchObject({ status: 403 });
    await updateExpenseSettings(ORG, { boardReviewTotalCents: 100_000 }, FINANCE);
    await updateExpenseSettings(ORG, { boardReviewTotalCents: 200_000 }, FINANCE);
    await updateExpenseSettings(ORG, { boardReviewTotalCents: 250_000 }, BOARD);

    await updateExpenseSettings(ORG, { capitalTotalThresholdCents: 500_000 }, FINANCE);
    await expect(updateExpenseSettings(ORG, { capitalTotalThresholdCents: 0 }, FINANCE)).rejects.toMatchObject({ status: 403 });
    await updateExpenseSettings(ORG, { capitalTotalThresholdCents: 0 }, BOARD);

    await expect(updateExpenseSettings(ORG, { boardReviewTotalCents: 100_000_001 }, BOARD)).rejects.toThrow();
    const changes = await db.expenseOrgSettingsChange.count({ where: { orgId: ORG } });
    expect(changes).toBe(5);
  });
});
