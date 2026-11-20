/**
 * A card charge in an org-level bucket takes no approval step (Financial Policy §XII.4): the system
 * approves it when the line lands in the bucket, takes the approval back when it leaves, and derives
 * it again when the bucket's org-level flag changes. Against the real database.
 */
import { beforeEach, it, expect } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { bindPorts, directory, principal, seedApproval, seedExpense, seedLineItem, seedOrgSettings, seedPartOwner, ORG } from "../helpers/seed";
import { holdBucketLines, signLine } from "../../services/signoffService";
import { assignOwner, financeAssign, raiseException } from "../../services/approvalService";
import { initFinancialFlow } from "../../lib/financial-flow";

const FINANCE = principal(3, { isFinance: true });
const GTIN = "0000000000017";
// Bucket 7 is org-level, 101 another org-level one, 100 a program's with approver 2.
const ports = () => bindPorts({ signoff: directory({ orgLevel: [7, 101], approvers: { 100: [2] }, finance: [3, 4], board: [5] }) });

const approvalOf = (id: number) => db.lineItemOwnerApproval.findUniqueOrThrow({ where: { id } });
const state = async (id: string) => (await db.expense.findUniqueOrThrow({ where: { id } })).state;
const audits = (expenseId: string, action: string) => db.expenseAuditLog.count({ where: { expenseId, action } });

// Not Everyday and with no Board authorization, so a signed Treasurer seat still leaves the Board seat open.
async function line(opts: { state: string; ownerId: number | null; status: string; needsReimbursement?: boolean }) {
  const id = await seedExpense({ state: opts.state, receiptTotalCents: 60_000, needsReimbursement: opts.needsReimbursement, reimburseePersonId: opts.needsReimbursement ? 1 : undefined });
  const li = await seedLineItem(id, { gtin13: GTIN, partNumber: null, manualQbAccount: "5000" });
  return { id, li, approvalId: await seedApproval(id, li, { ownerId: opts.ownerId, status: opts.status }) };
}

beforeEach(async () => {
  ports();
  await seedOrgSettings({ capitalReviewEnabled: false });
});

describeDb("the system's approval when a line lands in an org-level bucket", () => {
  it("a card charge mapped to one at intake is approved naming nobody, and audited", async () => {
    const id = await seedExpense({ state: "pending" });
    await seedLineItem(id, { gtin13: GTIN });
    await seedPartOwner({ gtin13: GTIN, ownerId: 7 });

    await initFinancialFlow(id, ORG);

    const [a] = await db.lineItemOwnerApproval.findMany({ where: { expenseId: id } });
    expect(a).toMatchObject({ ownerId: 7, status: "approved", decidedByUserId: null });
    expect(await audits(id, "line_item_approved_org_level")).toBe(1);
  });

  it("a reimbursement keeps its approval step", async () => {
    const id = await seedExpense({ state: "pending", needsReimbursement: true, reimburseePersonId: 1 });
    await seedLineItem(id, { gtin13: GTIN });
    await seedPartOwner({ gtin13: GTIN, ownerId: 7 });

    await initFinancialFlow(id, ORG);

    const [a] = await db.lineItemOwnerApproval.findMany({ where: { expenseId: id } });
    expect(a).toMatchObject({ ownerId: 7, status: "pending" });
  });

  it("FINANCE assigning one moves the expense past owner approval with no approver", async () => {
    const { id, approvalId } = await line({ state: "assign_ownership", ownerId: null, status: "pending" });

    await assignOwner(FINANCE, id, approvalId, 7);

    expect(await approvalOf(approvalId)).toMatchObject({ status: "approved", decidedByUserId: null });
    expect(await state(id)).toBe("qb_pending");
  });

  it("refuses an exception on it", async () => {
    const { id, approvalId } = await line({ state: "owner_approval", ownerId: 7, status: "pending" });
    await expect(raiseException(FINANCE, id, approvalId, "not ours")).rejects.toMatchObject({ status: 409 });
  });
});

describeDb("FINANCE moving a system-approved line", () => {
  it("into a program bucket, it waits for that bucket's approver", async () => {
    const { id, approvalId } = await line({ state: "qb_pending", ownerId: 7, status: "approved" });

    await financeAssign(FINANCE, id, approvalId, 100);

    expect(await approvalOf(approvalId)).toMatchObject({ status: "finance_assigned", ownerId: 100 });
    expect(await state(id)).toBe("owner_approval");
    expect(await audits(id, "finance_moved_line")).toBe(1);
  });

  it("into another org-level bucket, the system approves it again", async () => {
    const { id, approvalId } = await line({ state: "qb_pending", ownerId: 7, status: "approved" });

    await financeAssign(FINANCE, id, approvalId, 101);

    expect(await approvalOf(approvalId)).toMatchObject({ status: "approved", ownerId: 101, decidedByUserId: null });
    expect(await state(id)).toBe("qb_pending");
  });

  it("is refused once the Treasurer has signed", async () => {
    const { id, li, approvalId } = await line({ state: "qb_pending", ownerId: 7, status: "approved" });
    await signLine(FINANCE, li, "TREASURER");

    await expect(financeAssign(principal(4, { isFinance: true }), id, approvalId, 100)).rejects.toMatchObject({ status: 409 });
    expect(await approvalOf(approvalId)).toMatchObject({ status: "approved", ownerId: 7 });
  });
});

describeDb("changing a bucket's org-level flag", () => {
  it("to a program bucket reopens its system-approved card charges, and their later seats go", async () => {
    const { id, li, approvalId } = await line({ state: "qb_pending", ownerId: 7, status: "approved" });
    await signLine(FINANCE, li, "TREASURER");

    await holdBucketLines(7, false, async () => {});

    expect(await approvalOf(approvalId)).toMatchObject({ status: "pending", ownerId: 7 });
    expect(await db.expenseLineSignoff.count({ where: { lineItemId: li } })).toBe(0);
    expect(await state(id)).toBe("owner_approval");
  });

  it("to org-level approves its pending card charges, and leaves reimbursements pending", async () => {
    const card = await line({ state: "owner_approval", ownerId: 100, status: "pending" });
    const reimbursement = await line({ state: "owner_approval", ownerId: 100, status: "pending", needsReimbursement: true });

    await holdBucketLines(100, true, async () => {});

    expect(await approvalOf(card.approvalId)).toMatchObject({ status: "approved", decidedByUserId: null });
    expect(await state(card.id)).toBe("qb_pending");
    expect(await approvalOf(reimbursement.approvalId)).toMatchObject({ status: "pending" });
  });

  it("an expense already in QuickBooks refuses the change to a program bucket, naming the expense", async () => {
    const { id, approvalId } = await line({ state: "qb_pending", ownerId: 7, status: "approved" });
    await db.expense.update({ where: { id }, data: { qbTxnId: "4242" } });

    await expect(holdBucketLines(7, false, async () => {})).rejects.toMatchObject({ status: 409, message: `Expense ${id}: The expense is already in QuickBooks; correct it there` });

    expect(await approvalOf(approvalId)).toMatchObject({ status: "approved", ownerId: 7 });
  });

  it("a refused change keeps every approval as it was", async () => {
    const { approvalId } = await line({ state: "owner_approval", ownerId: 100, status: "pending" });

    await expect(holdBucketLines(100, true, async () => { throw new Error("refused"); })).rejects.toThrow("refused");

    expect(await approvalOf(approvalId)).toMatchObject({ status: "pending" });
  });
});
