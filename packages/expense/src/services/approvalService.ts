// Per-line budget-owner approval: the approvers of the line's bucket approve or raise an
// exception; FINANCE assigns buckets and settles exceptions.
import { db } from "../db";
import type { ExpensePrincipal } from "../contract";
import { getExpenseRuntime, getOrgId } from "../runtime";
import { actorOf, callerId } from "../lib/caller";
import { writeAudit } from "../lib/audit";
import { checkApprovalAutoTransition, checkOwnershipAutoTransition, isOrgLevelBucket } from "../lib/financial-flow";
import { createExpenseRepository } from "../repositories/expense";
import { createPartOwnerRepository } from "../repositories/partOwner";
import { ServiceError } from "./serviceError";

const expenseRepo = createExpenseRepository(db);

export function requireFinance(principal: ExpensePrincipal): void {
  callerId(principal);
  if (!principal.isFinance) throw new ServiceError(403, "Only finance users can do this");
}

/** True when the caller is a derived approver of the bucket (program leader or treasurer). */
export async function isBucketApprover(principal: ExpensePrincipal, bucketId: number | null): Promise<boolean> {
  if (bucketId === null) return false;
  const { approvers } = await getExpenseRuntime().signoff.bucketApprovers(bucketId);
  return approvers.includes(callerId(principal));
}

async function loadApproval(expenseId: string, approvalId: number, expectedState?: string) {
  const expense = await expenseRepo.findExpenseById(expenseId, await getOrgId());
  if (!expense) throw new ServiceError(404, "Expense not found");
  if (expectedState && expense.state !== expectedState) {
    throw new ServiceError(400, `Expense is not in ${expectedState} state`);
  }
  const approval = await expenseRepo.findApprovalById(approvalId, expenseId);
  if (!approval) throw new ServiceError(404, "Approval record not found");
  return { expense, approval };
}

function requireStatus(approval: { status: string }, status: string): void {
  if (approval.status !== status) throw new ServiceError(400, `Item is not in ${status} status`);
}

/** An approver approves; FINANCE may approve any line with an override comment (distinct audit action). */
export async function approveLine(
  principal: ExpensePrincipal,
  expenseId: string,
  approvalId: number,
  overrideComment?: string | null,
): Promise<void> {
  const actor = actorOf(principal);
  const { approval } = await loadApproval(expenseId, approvalId, "owner_approval");
  requireStatus(approval, "pending");

  let notes: string | null = null;
  if (!(await isBucketApprover(principal, approval.ownerId))) {
    if (!principal.isFinance) throw new ServiceError(403, "This line item is not in a bucket you approve");
    notes = overrideComment?.trim() || null;
    if (!notes) throw new ServiceError(400, "Override comment is required for finance approval");
  }

  await db.$transaction(async (tx) => {
    await tx.lineItemOwnerApproval.update({
      where: { id: approvalId },
      data: { status: "approved", decidedAt: new Date(), decidedByUserId: actor.userId, notes },
    });
    await writeAudit(tx, actor, {
      expenseId,
      action: notes ? "line_item_approved_finance_override" : "line_item_approved",
      lineItemId: approval.lineItemId,
      notes,
    });
  });

  await checkApprovalAutoTransition(expenseId, actor);
}

export async function raiseException(
  principal: ExpensePrincipal,
  expenseId: string,
  approvalId: number,
  notes: string,
): Promise<void> {
  const actor = actorOf(principal);
  const { approval } = await loadApproval(expenseId, approvalId, "owner_approval");
  requireStatus(approval, "pending");
  if (!principal.isFinance && !(await isBucketApprover(principal, approval.ownerId))) {
    throw new ServiceError(403, "This line item is not in a bucket you approve");
  }

  await db.$transaction(async (tx) => {
    await tx.lineItemOwnerApproval.update({
      where: { id: approvalId },
      data: { status: "exception_raised", notes, decidedAt: new Date(), decidedByUserId: actor.userId },
    });
    await writeAudit(tx, actor, { expenseId, action: "exception_raised", lineItemId: approval.lineItemId, valueAfter: notes });
  });
}

export async function rejectException(
  principal: ExpensePrincipal,
  expenseId: string,
  approvalId: number,
  notes: string,
): Promise<void> {
  requireFinance(principal);
  const actor = actorOf(principal);
  const { approval } = await loadApproval(expenseId, approvalId, "owner_approval");
  requireStatus(approval, "exception_raised");

  await db.$transaction(async (tx) => {
    await tx.lineItemOwnerApproval.update({
      where: { id: approvalId },
      data: { status: "rejected", notes, decidedAt: new Date(), decidedByUserId: actor.userId },
    });
    await writeAudit(tx, actor, {
      expenseId,
      action: "finance_rejected_exception",
      lineItemId: approval.lineItemId,
      valueBefore: "exception_raised",
      valueAfter: notes,
    });
  });

  await checkApprovalAutoTransition(expenseId, actor);
}

export async function financeAssign(
  principal: ExpensePrincipal,
  expenseId: string,
  approvalId: number,
  ownerId: number,
): Promise<void> {
  requireFinance(principal);
  const actor = actorOf(principal);
  const { approval } = await loadApproval(expenseId, approvalId, "owner_approval");
  requireStatus(approval, "exception_raised");

  await db.$transaction(async (tx) => {
    await tx.lineItemOwnerApproval.update({
      where: { id: approvalId },
      data: { ownerId, status: "finance_assigned", decidedAt: new Date(), decidedByUserId: actor.userId },
    });
    await writeAudit(tx, actor, {
      expenseId,
      action: "finance_assigned_exception",
      lineItemId: approval.lineItemId,
      valueBefore: "exception_raised",
      valueAfter: String(ownerId),
    });
  });

  await checkApprovalAutoTransition(expenseId, actor);
}

/**
 * FINANCE assigns a bucket to an unassigned line. `permanent` also maps the part to the bucket
 * and assigns every other unassigned pending line with the same GTIN.
 */
export async function assignOwner(
  principal: ExpensePrincipal,
  expenseId: string,
  approvalId: number,
  ownerId: number,
  permanent = false,
): Promise<void> {
  requireFinance(principal);
  const actor = actorOf(principal);
  const { expense, approval } = await loadApproval(expenseId, approvalId, "assign_ownership");
  if (approval.ownerId !== null && approval.status !== "pending") {
    throw new ServiceError(400, "This item already has an owner assigned");
  }

  const lineItem = await expenseRepo.findLineItemById(approval.lineItemId);
  const gtin13 = permanent ? (lineItem?.gtin13 ?? null) : null;
  const [sameExpense, siblings] = gtin13
    ? await Promise.all([
        expenseRepo.listSameExpenseUnassignedApprovalsByGtin13(expenseId, gtin13, approvalId),
        expenseRepo.listSiblingApprovals(expense.orgId, gtin13, expenseId),
      ])
    : [[], []];

  const status = (await isOrgLevelBucket(ownerId)) ? "approved" : "pending";
  const now = new Date();
  const assigned = { ownerId, status, decidedAt: now, decidedByUserId: actor.userId };

  await db.$transaction(async (tx) => {
    await tx.lineItemOwnerApproval.update({ where: { id: approvalId }, data: assigned });
    await writeAudit(tx, actor, {
      expenseId,
      action: permanent ? "owner_assigned_permanent" : "owner_assigned_one_time",
      lineItemId: approval.lineItemId,
      valueBefore: String(approval.ownerId ?? "null"),
      valueAfter: String(ownerId),
    });

    for (const s of [...sameExpense.map((a) => ({ ...a, expenseId })), ...siblings]) {
      await tx.lineItemOwnerApproval.update({ where: { id: s.approvalId }, data: assigned });
      await writeAudit(tx, actor, {
        expenseId: s.expenseId,
        action: "owner_auto_assigned_permanent",
        lineItemId: s.lineItemId,
        valueBefore: "null",
        valueAfter: String(ownerId),
      });
    }

    if (gtin13) await createPartOwnerRepository(tx).updateItemOwner(expense.orgId, gtin13, ownerId);
  });

  for (const id of new Set([expenseId, ...siblings.map((s) => s.expenseId)])) {
    await checkOwnershipAutoTransition(id, actor);
  }
}

export async function resolveUnknown(
  principal: ExpensePrincipal,
  expenseId: string,
  approvalId: number,
  ownerId: number,
): Promise<void> {
  requireFinance(principal);
  const actor = actorOf(principal);
  const { approval } = await loadApproval(expenseId, approvalId);
  requireStatus(approval, "unknown");

  const status = (await isOrgLevelBucket(ownerId)) ? "approved" : "pending";
  await db.$transaction(async (tx) => {
    await tx.lineItemOwnerApproval.update({
      where: { id: approvalId },
      data: { ownerId, status, decidedAt: new Date(), decidedByUserId: actor.userId },
    });
    await writeAudit(tx, actor, {
      expenseId,
      action: "finance_resolved_unknown",
      lineItemId: approval.lineItemId,
      valueBefore: "unknown",
      valueAfter: String(ownerId),
    });
  });

  await checkOwnershipAutoTransition(expenseId, actor);
}
