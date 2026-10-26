/**
 * Integrity of the sign-off chain against the real database: seats in order after the line's
 * approval, seats tied to the payee, valid buckets, independent flag check-offs, serialized sign-offs, and the payee carried
 * into the outbox.
 */
import { it, expect } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { bindPorts, directory, principal, seedApproval, seedExpense, seedLineItem, signAllLines, ORG, seedSubmitterSeat } from "../helpers/seed";
import { setReimbursee, signLine } from "../../services/signoffService";
import { approveLine, assignOwner, financeAssign, raiseException, resolveUnknown } from "../../services/approvalService";
import { checkOffFlag, raiseFlag } from "../../services/flagService";
import { checkAndProcessExpense } from "../../lib/expense-qb-processor";
import { signoffFactsByLine } from "../../lib/signoff-facts";
import { updateExpenseSettings } from "../../services/settingsService";

const FINANCE = principal(3, { isFinance: true });
const BOARD = principal(5, { isBoard: true });
const seatsOf = async (lineItemId: number) =>
  (await db.expenseLineSignoff.findMany({ where: { lineItemId }, orderBy: { id: "asc" } })).map((s) => [s.seat, s.signerUserId]);

describeDb("seats follow the line's approval", () => {
  it("nobody signs as Treasurer before the line has a bucket and is approved, not even the Board", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [2] }, finance: [3], board: [5] }) });
    const id = await seedExpense({ state: "assign_ownership" });
    const li = await seedLineItem(id);
    await seedApproval(id, li, { ownerId: null });

    await expect(signLine(FINANCE, li, "TREASURER")).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/not approved yet/) });
    await expect(signLine(BOARD, li, "TREASURER")).rejects.toMatchObject({ status: 403 });
    expect(await seatsOf(li)).toEqual([]);
  });

  it("a line moved to another bucket has nothing after its approval to void, and waits for the new bucket's approver", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [2], 101: [4] }, finance: [3], board: [5] }) });
    const id = await seedExpense({ state: "owner_approval", needsReimbursement: true, reimburseePersonId: 1 });
    const li = await seedLineItem(id);
    const approvalId = await seedApproval(id, li, { ownerId: 100 });
    await seedSubmitterSeat(li, 1);

    await raiseException(principal(2), id, approvalId, "not ours");
    await financeAssign(FINANCE, id, approvalId, 101);

    expect(await seatsOf(li)).toEqual([["SUBMITTER", 1]]);
    expect(await db.expenseAuditLog.count({ where: { expenseId: id, action: "signoff_voided" } })).toBe(0);
    await expect(signLine(FINANCE, li, "TREASURER")).rejects.toMatchObject({ status: 403 });
    await expect(approveLine(principal(2), id, approvalId)).rejects.toMatchObject({ status: 403 });
    await approveLine(principal(4), id, approvalId);
    await signLine(FINANCE, li, "TREASURER");
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
    await seedApproval(id, li, { ownerId: 100, status: "approved", decidedByUserId: 2 });
    await seedSubmitterSeat(li, 7);
    await signLine(FINANCE, li, "TREASURER");

    await expect(setReimbursee(ORG, id, 9, principal(4, { isFinance: true }))).rejects.toMatchObject({ status: 409 });

    expect((await db.expense.findFirst({ where: { id } }))!.reimburseePersonId).toBe(7);
    expect(await seatsOf(li)).toEqual([["SUBMITTER", 7], ["TREASURER", 3]]);
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
    await seedSubmitterSeat(li, 1);

    await expect(signLine(FINANCE, li, "TREASURER")).rejects.toMatchObject({ status: 403 });
    await signLine(principal(4, { isFinance: true }), li, "TREASURER");
    expect(await db.expenseEvent.count({ where: { expenseId: id } })).toBe(1);
  });

  it("a reimbursee that came with the receipt was named by its uploader, who never signs as Treasurer", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [2] }, finance: [1, 3], board: [5] }) });
    const id = await seedExpense({ state: "qb_pending", needsReimbursement: true, reimburseePersonId: 7 });
    const li = await seedLineItem(id, { partNumber: null, manualQbAccount: "5000" });
    await seedApproval(id, li, { ownerId: 100, status: "approved" });

    const expense = await db.expense.findUniqueOrThrow({ where: { id } });
    expect((await signoffFactsByLine(db, expense)).get(li)!.reimburseeSetter).toBe(1);
    await expect(signLine(principal(1, { isFinance: true }), li, "TREASURER")).rejects.toMatchObject({ status: 403 });
    await signLine(FINANCE, li, "TREASURER");
  });

  it("the only FINANCE holder named the reimbursee: a Board member takes the Treasurer seat", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [2] }, finance: [3], board: [3, 5] }) });
    const id = await seedExpense({ state: "owner_approval", needsReimbursement: true });
    const li = await seedLineItem(id);
    await seedApproval(id, li, { ownerId: 100, status: "approved", decidedByUserId: 2 });

    await setReimbursee(ORG, id, 1, FINANCE);

    await expect(signLine(principal(3, { isFinance: true, isBoard: true }), li, "TREASURER")).rejects.toMatchObject({ status: 403 });
    await signLine(BOARD, li, "TREASURER");
  });

  it("the outbox commits with the reimbursee the seats were signed for", async () => {
    const id = await seedExpense({ state: "qb_pending", needsReimbursement: true, reimburseePersonId: 9 });
    const li = await seedLineItem(id, { partNumber: null, manualQbAccount: "5000" });
    await seedApproval(id, li, { ownerId: 100, status: "approved" });
    await signAllLines(id);

    await checkAndProcessExpense(ORG, id);

    expect(await db.expenseEvent.count({ where: { expenseId: id } })).toBe(1);
    expect(await db.expense.findUniqueOrThrow({ where: { id } })).toMatchObject({ needsReimbursement: true, reimburseePersonId: 9 });
  });
});

describeDb("flags are checked off independently", () => {
  it("a party to the expense, or their household, cannot check off its flags", async () => {
    bindPorts({ signoff: directory({ households: [[1, 6]] }) });
    const id = await seedExpense({ submitterId: 1 });
    await raiseFlag(id, "QB_DRIFT", "amount");
    const flag = (await db.expenseFlag.findFirst({ where: { expenseId: id } }))!;

    await expect(checkOffFlag(principal(1, { isFinance: true }), flag.id, "seen")).rejects.toMatchObject({ status: 403 });
    await expect(checkOffFlag(principal(6, { isFinance: true }), flag.id, "seen")).rejects.toMatchObject({ status: 403 });
    await checkOffFlag(FINANCE, flag.id, "seen");
  });
});

describeDb("threshold changes", () => {
  it("FINANCE tightens and loosens within policy; past policy, or raising a capital threshold, is the Board's", async () => {
    await expect(updateExpenseSettings(ORG, { boardReviewTotalCents: 250_000 }, FINANCE)).rejects.toMatchObject({ status: 403 });
    await updateExpenseSettings(ORG, { boardReviewTotalCents: 100_000 }, FINANCE);
    await updateExpenseSettings(ORG, { boardReviewTotalCents: 200_000 }, FINANCE);
    await updateExpenseSettings(ORG, { boardReviewTotalCents: 250_000 }, BOARD);

    await expect(updateExpenseSettings(ORG, { capitalTotalThresholdCents: 500_000 }, FINANCE)).rejects.toMatchObject({ status: 403 });
    await updateExpenseSettings(ORG, { capitalTotalThresholdCents: 500_000 }, BOARD);
    await updateExpenseSettings(ORG, { capitalTotalThresholdCents: 0 }, FINANCE);

    await expect(updateExpenseSettings(ORG, { boardReviewTotalCents: 100_000_001 }, BOARD)).rejects.toThrow();
    const changes = await db.expenseOrgSettingsChange.count({ where: { orgId: ORG } });
    expect(changes).toBe(5);
  });

  it("only the Board changes the Everyday limits, lowering included", async () => {
    await expect(updateExpenseSettings(ORG, { everydayTotalLimitCents: 40_000 }, FINANCE)).rejects.toMatchObject({ status: 403 });
    await expect(updateExpenseSettings(ORG, { everydayItemLimitCents: 30_000 }, FINANCE)).rejects.toMatchObject({ status: 403 });
    await updateExpenseSettings(ORG, { everydayTotalLimitCents: 50_000, boardReviewTotalCents: 100_000 }, FINANCE);
    await updateExpenseSettings(ORG, { everydayTotalLimitCents: 40_000, everydayItemLimitCents: 30_000 }, BOARD);
    expect(await db.expenseOrgSettingsChange.count({ where: { orgId: ORG } })).toBe(2);
  });
});
