// Per-line budget-owner approval: the approvers of the line's bucket approve or raise an
// exception; FINANCE assigns buckets and settles exceptions.
import type { Prisma } from "../generated/prisma/client";
import { db } from "../db";
import type { ExpensePrincipal } from "../contract";
import { getExpenseRuntime, getOrgId } from "../runtime";
import { actorOf, callerId } from "../lib/caller";
import { writeAudit } from "../lib/audit";
import { checkApprovalAutoTransition, checkOwnershipAutoTransition, isOrgLevelBucket, liveBucketIds } from "../lib/financial-flow";
import { conflictedParties, lockExpense, voidSignoffs } from "../lib/signoff-facts";
import { createExpenseRepository } from "../repositories/expense";
import { createPartOwnerRepository } from "../repositories/partOwner";
import { ServiceError } from "@checkin/component-kit";

const expenseRepo = createExpenseRepository(db);

export function requireFinance(principal: ExpensePrincipal): void {
  callerId(principal);
  if (!principal.isFinance) throw new ServiceError(403, "Only finance users can do this");
}

/** True when the caller is a derived approver of the bucket (bucket owner or treasurer). */
export async function isBucketApprover(principal: ExpensePrincipal, bucketId: number | null): Promise<boolean> {
  if (bucketId === null) return false;
  const { approvers } = await getExpenseRuntime().signoff.bucketApprovers(bucketId);
  return approvers.includes(callerId(principal));
}

/** Every id is a bucket a line may be assigned to: one the host lists, not archived. */
export async function requireLiveBuckets(ownerIds: number[]): Promise<void> {
  if (ownerIds.length === 0) return;
  const live = await liveBucketIds();
  if (ownerIds.some((id) => !live.has(id))) throw new ServiceError(400, "Unknown or archived budget bucket");
}

const BUCKET_CHANGED = "the line's budget bucket changed";

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

/** Refuses a decision by the submitter, the reimbursee, or anyone in their households. */
async function refuseConflicted(principal: ExpensePrincipal, expense: { submitterId: number; reimburseePersonId: number | null }): Promise<void> {
  if ((await conflictedParties(expense)).includes(callerId(principal))) {
    throw new ServiceError(403, "You cannot decide a line on an expense that you or your household submitted or would be reimbursed for");
  }
}

type ApprovalRead = { id: number; status: string; ownerId: number | null };

/**
 * Writes the approval only if its status and bucket are still what the caller read, so of two
 * racing decisions the later one is refused instead of silently replacing the earlier one.
 */
async function transition(tx: Prisma.TransactionClient, read: ApprovalRead, data: Prisma.LineItemOwnerApprovalUncheckedUpdateManyInput): Promise<void> {
  const { count } = await tx.lineItemOwnerApproval.updateMany({
    where: { id: read.id, status: read.status, ownerId: read.ownerId },
    data,
  });
  if (count === 0) throw new ServiceError(409, "This line changed; reload");
}

/**
 * The refusals every approval runs, single or batch. Returns the override comment FINANCE gave
 * when approving outside its own buckets, or null for a bucket approver.
 */
async function approvalNotes(
  principal: ExpensePrincipal,
  expense: { submitterId: number; reimburseePersonId: number | null },
  approval: ApprovalRead,
  overrideComment?: string | null,
): Promise<string | null> {
  requireStatus(approval, "pending");
  await refuseConflicted(principal, expense);
  if (await isBucketApprover(principal, approval.ownerId)) return null;
  if (!principal.isFinance) throw new ServiceError(403, "This line item is not in a bucket you approve");
  const notes = overrideComment?.trim() || null;
  if (!notes) throw new ServiceError(400, "Override comment is required for finance approval");
  return notes;
}

async function recordApproval(
  tx: Prisma.TransactionClient,
  actor: ReturnType<typeof actorOf>,
  expenseId: string,
  approval: ApprovalRead & { lineItemId: number },
  notes: string | null,
): Promise<void> {
  await transition(tx, approval, { status: "approved", decidedAt: new Date(), decidedByUserId: actor.userId, notes });
  await writeAudit(tx, actor, {
    expenseId,
    action: notes ? "line_item_approved_finance_override" : "line_item_approved",
    lineItemId: approval.lineItemId,
    notes,
  });
}

/** An approver approves; FINANCE may approve any line with an override comment (distinct audit action). */
export async function approveLine(
  principal: ExpensePrincipal,
  expenseId: string,
  approvalId: number,
  overrideComment?: string | null,
): Promise<void> {
  const actor = actorOf(principal);
  const { expense, approval } = await loadApproval(expenseId, approvalId, "owner_approval");
  const notes = await approvalNotes(principal, expense, approval, overrideComment);

  await db.$transaction((tx) => recordApproval(tx, actor, expenseId, approval, notes));

  await checkApprovalAutoTransition(expenseId, actor);
}

/**
 * Approve All: approves every listed line under the expense lock, each through the same refusals
 * as a single approval, or none of them. A refusal names the line by its number.
 */
export async function approveLines(principal: ExpensePrincipal, expenseId: string, approvalIds: number[]): Promise<void> {
  const actor = actorOf(principal);
  const ids = [...new Set(approvalIds)];
  if (ids.length === 0) throw new ServiceError(400, "Name at least one line to approve");

  await db.$transaction(async (tx) => {
    await lockExpense(tx, expenseId);
    const expense = await tx.expense.findFirst({ where: { id: expenseId, orgId: await getOrgId() } });
    if (!expense) throw new ServiceError(404, "Expense not found");
    if (expense.state !== "owner_approval") throw new ServiceError(400, "Expense is not in owner_approval state");
    const approvals = await tx.lineItemOwnerApproval.findMany({
      where: { expenseId, id: { in: ids } },
      include: { lineItem: { select: { lineNumber: true } } },
      orderBy: { lineItem: { lineNumber: "asc" } },
    });
    if (approvals.length !== ids.length) throw new ServiceError(404, "Approval record not found");
    for (const approval of approvals) {
      try {
        // No override comment: a line that needs one is refused here, as a single approval without it is.
        await recordApproval(tx, actor, expenseId, approval, await approvalNotes(principal, expense, approval));
      } catch (err) {
        if (err instanceof ServiceError) throw new ServiceError(err.status, `Line ${approval.lineItem.lineNumber}: ${err.message}`);
        throw err;
      }
    }
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
  const { expense, approval } = await loadApproval(expenseId, approvalId, "owner_approval");
  requireStatus(approval, "pending");
  if (!principal.isFinance && !(await isBucketApprover(principal, approval.ownerId))) {
    throw new ServiceError(403, "This line item is not in a bucket you approve");
  }
  await refuseConflicted(principal, expense);

  await db.$transaction(async (tx) => {
    await transition(tx, approval, { status: "exception_raised", notes, decidedAt: new Date(), decidedByUserId: actor.userId });
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
  const { expense, approval } = await loadApproval(expenseId, approvalId, "owner_approval");
  requireStatus(approval, "exception_raised");
  await refuseConflicted(principal, expense);

  await db.$transaction(async (tx) => {
    await transition(tx, approval, { status: "rejected", notes, decidedAt: new Date(), decidedByUserId: actor.userId });
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
  await requireLiveBuckets([ownerId]);
  const { expense, approval } = await loadApproval(expenseId, approvalId, "owner_approval");
  requireStatus(approval, "exception_raised");
  await refuseConflicted(principal, expense);

  await db.$transaction(async (tx) => {
    await lockExpense(tx, expenseId);
    await transition(tx, approval, { ownerId, status: "finance_assigned", decidedAt: new Date(), decidedByUserId: actor.userId });
    if (approval.ownerId !== ownerId) await voidSignoffs(tx, actor, expenseId, [approval.lineItemId], BUCKET_CHANGED);
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
  await requireLiveBuckets([ownerId]);
  const { expense, approval } = await loadApproval(expenseId, approvalId, "assign_ownership");
  if (approval.ownerId !== null && approval.status !== "pending") {
    throw new ServiceError(400, "This item already has an owner assigned");
  }
  await refuseConflicted(principal, expense);

  const lineItem = await expenseRepo.findLineItemById(approval.lineItemId);
  const gtin13 = permanent && !lineItem?.nonInventory ? (lineItem?.gtin13 ?? null) : null;
  const [sameExpense, listed] = gtin13
    ? await Promise.all([
        expenseRepo.listSameExpenseUnassignedApprovalsByGtin13(expenseId, gtin13, approvalId),
        expenseRepo.listSiblingApprovals(expense.orgId, gtin13, expenseId),
      ])
    : [[], []];
  // A sibling on an expense the caller is conflicted on stays unassigned for someone else.
  const caller = callerId(principal);
  const conflicted = await Promise.all(listed.map(async (s) => (await conflictedParties(s)).includes(caller)));
  const siblings = listed.filter((_, i) => !conflicted[i]);

  const status = (await isOrgLevelBucket(ownerId)) ? "approved" : "pending";
  const now = new Date();
  const assigned = { ownerId, status, decidedAt: now, decidedByUserId: actor.userId };

  await db.$transaction(async (tx) => {
    // Sorted, so two assignments touching the same expenses lock them in the same order.
    for (const id of [...new Set([expenseId, ...siblings.map((s) => s.expenseId)])].sort()) await lockExpense(tx, id);
    await transition(tx, approval, assigned);
    if (approval.ownerId !== ownerId) await voidSignoffs(tx, actor, expenseId, [approval.lineItemId], BUCKET_CHANGED);
    await writeAudit(tx, actor, {
      expenseId,
      action: permanent ? "owner_assigned_permanent" : "owner_assigned_one_time",
      lineItemId: approval.lineItemId,
      valueBefore: String(approval.ownerId ?? "null"),
      valueAfter: String(ownerId),
    });

    for (const s of [...sameExpense.map((a) => ({ ...a, expenseId })), ...siblings]) {
      // A line assigned since it was listed keeps that assignment.
      const { count } = await tx.lineItemOwnerApproval.updateMany({ where: { id: s.approvalId, ownerId: null }, data: assigned });
      if (count === 0) continue;
      await voidSignoffs(tx, actor, s.expenseId, [s.lineItemId], BUCKET_CHANGED);
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
  await requireLiveBuckets([ownerId]);
  const { expense, approval } = await loadApproval(expenseId, approvalId);
  requireStatus(approval, "unknown");
  await refuseConflicted(principal, expense);

  const status = (await isOrgLevelBucket(ownerId)) ? "approved" : "pending";
  await db.$transaction(async (tx) => {
    await lockExpense(tx, expenseId);
    await transition(tx, approval, { ownerId, status, decidedAt: new Date(), decidedByUserId: actor.userId });
    if (approval.ownerId !== ownerId) await voidSignoffs(tx, actor, expenseId, [approval.lineItemId], BUCKET_CHANGED);
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
