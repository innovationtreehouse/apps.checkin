/**
 * Per-line approval services against the real database: bucket approvers, the finance
 * override, FINANCE assignment (incl. permanent and org-level), and the reject path.
 */
import { it, expect } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { bindPorts, directory, principal, seedApproval, seedExpense, seedLineItem, ORG } from "../helpers/seed";
import { approveLine, assignOwner, financeAssign, raiseException, rejectException } from "../../services/approvalService";

const LEADER = principal(2);
const FINANCE = principal(3, { isFinance: true });
const STRANGER = principal(9);

async function lineInApproval(ownerId: number | null = 100, status = "pending") {
  const id = await seedExpense({ state: ownerId === null ? "assign_ownership" : "owner_approval" });
  const li = await seedLineItem(id, { gtin13: "0000000000017" });
  return { id, li, approvalId: await seedApproval(id, li, { ownerId, status }) };
}
const approval = (id: number) => db.lineItemOwnerApproval.findFirst({ where: { id } });
const state = async (id: string) => (await db.expense.findFirst({ where: { id } }))!.state;

describeDb("approveLine", () => {
  it("an approver of the line's bucket approves; attribution comes from the principal", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [2] } }) });
    const { id, approvalId } = await lineInApproval();

    await approveLine(LEADER, id, approvalId);

    expect(await approval(approvalId)).toMatchObject({ status: "approved", decidedByUserId: 2 });
    expect(await state(id)).toBe("qb_pending");
  });

  it("a caller who approves no bucket is refused", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [2] } }) });
    const { id, approvalId } = await lineInApproval();
    await expect(approveLine(STRANGER, id, approvalId)).rejects.toMatchObject({ statusCode: 403 });
  });

  it("FINANCE overrides only with a comment, under a distinct audit action", async () => {
    const { id, approvalId } = await lineInApproval();
    await expect(approveLine(FINANCE, id, approvalId)).rejects.toMatchObject({ statusCode: 400 });

    await approveLine(FINANCE, id, approvalId, "leader away");

    const audit = await db.expenseAuditLog.findMany({ where: { expenseId: id, action: "line_item_approved_finance_override" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ userId: 3, notes: "leader away" });
  });
});

describeDb("exceptions", () => {
  it("an approver raises an exception; FINANCE rejecting it refuses the whole expense", async () => {
    bindPorts({ signoff: directory({ approvers: { 100: [2] } }) });
    const { id, approvalId } = await lineInApproval();

    await raiseException(LEADER, id, approvalId, "not ours");
    await expect(rejectException(LEADER, id, approvalId, "no")).rejects.toMatchObject({ statusCode: 403 });
    await rejectException(FINANCE, id, approvalId, "refusing this charge");

    expect(await approval(approvalId)).toMatchObject({ status: "rejected" });
    expect(await state(id)).toBe("rejected");
  });

  it("FINANCE assigning an exception proceeds", async () => {
    const { id, approvalId } = await lineInApproval(100, "exception_raised");
    await financeAssign(FINANCE, id, approvalId, 101);
    expect(await approval(approvalId)).toMatchObject({ status: "finance_assigned", ownerId: 101 });
    expect(await state(id)).toBe("qb_pending");
  });
});

describeDb("assignOwner", () => {
  it("permanent assignment maps the part and assigns sibling lines in other expenses", async () => {
    const a = await lineInApproval(null);
    const b = await lineInApproval(null);

    await assignOwner(FINANCE, a.id, a.approvalId, 100, true);

    expect(await approval(b.approvalId)).toMatchObject({ ownerId: 100, status: "pending" });
    expect((await db.partOwnerMap.findFirst({ where: { orgId: ORG, gtin13: "0000000000017" } }))?.ownerId).toBe(100);
    expect(await state(a.id)).toBe("owner_approval");
    expect(await state(b.id)).toBe("owner_approval");
  });

  it("assigning an org-level bucket is the approval", async () => {
    bindPorts({ signoff: directory({ orgLevel: [7] }) });
    const { id, approvalId } = await lineInApproval(null);

    await assignOwner(FINANCE, id, approvalId, 7);

    expect(await approval(approvalId)).toMatchObject({ ownerId: 7, status: "approved", decidedByUserId: 3 });
    expect(await state(id)).toBe("qb_pending");
  });

  it("only FINANCE assigns", async () => {
    const { id, approvalId } = await lineInApproval(null);
    await expect(assignOwner(LEADER, id, approvalId, 100)).rejects.toMatchObject({ statusCode: 403 });
  });
});
