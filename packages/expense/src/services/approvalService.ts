// Per-line budget-owner approval, the program approver's sign-off: the approvers of the line's
// bucket, or a Board member in their place, approve; FINANCE assigns buckets and settles exceptions.
import type { Prisma } from "../generated/prisma/client";
import { db } from "../db";
import type { ExpensePrincipal } from "../contract";
import { getExpenseRuntime, getOrgId } from "../runtime";
import { actorOf, callerId } from "../lib/caller";
import { writeAudit } from "../lib/audit";
import { checkApprovalAutoTransition, checkOwnershipAutoTransition, liveBucketIds } from "../lib/financial-flow";
import { conflictedParties, filledSeatsByLine, lockExpense, signoffFactsByLine } from "../lib/signoff-facts";
import { APPROVABLE_STATUSES, approvalRefusal, approvesAsStandIn, reimburseeUnknown } from "../lib/signoff";
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

/** Refuses an exception's raising or rejection by the submitter, the reimbursee, or anyone in their households. */
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

const BUCKET_FINAL = "Finance made this line's bucket final; its approver approves it, or a Board member stands in";

/**
 * The program approver's sign-off on one line, inside a transaction holding the expense lock. A
 * bucket approver approves; a Board member without a conflict may approve any line in place of its
 * approvers, giving the reason, which is kept on the approval and its audit row. Whoever a seat on
 * the line would refuse is refused. With `soleStandIn`, a Board stand-in is refused while a bucket
 * approver could approve the line.
 */
async function approveLocked(
  tx: Prisma.TransactionClient,
  actor: ReturnType<typeof actorOf>,
  expense: Awaited<ReturnType<typeof lockedInOwnerApproval>>,
  approval: ApprovalRead & { lineItemId: number },
  text: string | null,
  soleStandIn = false,
): Promise<void> {
  if (!APPROVABLE_STATUSES.has(approval.status)) throw new ServiceError(400, "Item is not in pending status");
  const facts = (await signoffFactsByLine(tx, expense)).get(approval.lineItemId)!;
  const filled = (await filledSeatsByLine(tx, expense.id)).get(approval.lineItemId) ?? [];
  const refusal = approvalRefusal(facts, filled, actor.userId);
  if (refusal) throw new ServiceError(403, refusal);
  const standIn = approvesAsStandIn(facts, actor.userId);
  if (standIn && soleStandIn && facts.approvers.some((id) => approvalRefusal(facts, filled, id) === null)) {
    throw new ServiceError(403, "A bucket approver can approve this line; a Board member approves it on its own, giving the reason");
  }
  if (standIn && !facts.orgLevel && !text) {
    throw new ServiceError(400, "A Board member approving in place of the bucket's approvers gives the reason");
  }
  const notes = standIn ? text : null;
  await transition(tx, approval, { status: "approved", decidedAt: new Date(), decidedByUserId: actor.userId, notes });
  await writeAudit(tx, actor, {
    expenseId: expense.id,
    action: standIn ? "line_item_approved_board_stand_in" : "line_item_approved",
    lineItemId: approval.lineItemId,
    notes,
  });
}

/** Locks the expense and returns it. */
async function lockedExpense(tx: Prisma.TransactionClient, expenseId: string) {
  await lockExpense(tx, expenseId);
  const expense = await tx.expense.findFirst({ where: { id: expenseId, orgId: await getOrgId() } });
  if (!expense) throw new ServiceError(404, "Expense not found");
  return expense;
}

/** Locks the expense and returns it, refused unless it waits for owner approval with its reimbursee known. */
async function lockedInOwnerApproval(tx: Prisma.TransactionClient, expenseId: string) {
  return inOwnerApproval(await lockedExpense(tx, expenseId));
}

/** The expense, refused unless it waits for owner approval with its reimbursee known. */
function inOwnerApproval(expense: Awaited<ReturnType<typeof lockedExpense>>) {
  if (expense.state !== "owner_approval") throw new ServiceError(400, "Expense is not in owner_approval state");
  if (reimburseeUnknown(expense)) throw new ServiceError(409, "The reimbursee is unknown; FINANCE sets it before anyone approves");
  return expense;
}

/** Approves one line; see approveLocked for who may. */
export async function approveLine(
  principal: ExpensePrincipal,
  expenseId: string,
  approvalId: number,
  reason?: string | null,
): Promise<void> {
  const actor = actorOf(principal);
  const { approval } = await loadApproval(expenseId, approvalId, "owner_approval");
  if (!APPROVABLE_STATUSES.has(approval.status)) throw new ServiceError(400, "Item is not in pending status");

  // Facts are read under the expense row lock, so a seat or another approval cannot commit
  // between the eligibility check and the write.
  await db.$transaction(async (tx) => {
    const expense = await lockedInOwnerApproval(tx, expenseId);
    await approveLocked(tx, actor, expense, approval, reason?.trim() || null);
  });

  await checkApprovalAutoTransition(expenseId, actor);
}

/**
 * Approve All: approves every listed line under one expense lock, each through the same checks as
 * a single approval, or none of them. A Board stand-in is approved only on a line no bucket
 * approver can approve. A refusal names the line by its number. A line the caller already approved
 * counts as done, so retrying a batch that committed succeeds without writing anything.
 */
export async function approveLines(principal: ExpensePrincipal, expenseId: string, approvalIds: number[]): Promise<void> {
  const actor = actorOf(principal);
  const ids = [...new Set(approvalIds)];
  if (ids.length === 0) throw new ServiceError(400, "Name at least one line to approve");

  await db.$transaction(async (tx) => {
    const locked = await lockedExpense(tx, expenseId);
    const approvals = await tx.lineItemOwnerApproval.findMany({
      where: { expenseId, id: { in: ids } },
      include: { lineItem: { select: { lineNumber: true } } },
      orderBy: { lineItem: { lineNumber: "asc" } },
    });
    if (approvals.length !== ids.length) throw new ServiceError(404, "Approval record not found");
    const todo = approvals.filter((a) => a.status !== "approved" || a.decidedByUserId !== actor.userId);
    if (todo.length === 0) return;
    const expense = inOwnerApproval(locked);
    for (const approval of todo) {
      try {
        // No reason: a stand-in line that needs one is refused, as a single approval without it is.
        await approveLocked(tx, actor, expense, approval, null, true);
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
  const { approval } = await loadApproval(expenseId, approvalId, "owner_approval");
  if (!APPROVABLE_STATUSES.has(approval.status)) throw new ServiceError(400, "Item is not in pending status");
  if (approval.bucketFinal) throw new ServiceError(409, BUCKET_FINAL);
  if (!principal.isFinance && !(await isBucketApprover(principal, approval.ownerId))) {
    throw new ServiceError(403, "This line item is not in a bucket you approve");
  }

  await db.$transaction(async (tx) => {
    await refuseConflicted(principal, await lockedInOwnerApproval(tx, expenseId));
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
    await lockExpense(tx, expenseId);
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

/**
 * FINANCE settles an exception by moving the line to another bucket; it is not an approval, so the
 * line waits for that bucket's approver. Made `final`, with a required note kept on the approval
 * and its audit row, the line takes no further exception; made final by a FINANCE holder conflicted
 * on the expense, the line also takes the Board seat (signoff-facts reads the audit row).
 */
export async function financeAssign(
  principal: ExpensePrincipal,
  expenseId: string,
  approvalId: number,
  ownerId: number,
  final = false,
  note?: string | null,
): Promise<void> {
  requireFinance(principal);
  const actor = actorOf(principal);
  const finalNote = note?.trim() || null;
  if (final && !finalNote) throw new ServiceError(400, "Say why finance makes this bucket final");
  await requireLiveBuckets([ownerId]);
  const { approval } = await loadApproval(expenseId, approvalId, "owner_approval");
  requireStatus(approval, "exception_raised");

  await db.$transaction(async (tx) => {
    await lockExpense(tx, expenseId);
    await transition(tx, approval, {
      ownerId,
      status: "finance_assigned",
      decidedAt: new Date(),
      decidedByUserId: actor.userId,
      ...(final ? { bucketFinal: true, notes: finalNote } : {}),
    });
    await writeAudit(tx, actor, {
      expenseId,
      action: "finance_assigned_exception",
      lineItemId: approval.lineItemId,
      valueBefore: "exception_raised",
      valueAfter: String(ownerId),
    });
    if (final) {
      await writeAudit(tx, actor, { expenseId, action: "bucket_made_final", lineItemId: approval.lineItemId, fieldChanged: "bucketFinal", valueAfter: String(ownerId), notes: finalNote });
    }
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

  const lineItem = await expenseRepo.findLineItemById(approval.lineItemId);
  const gtin13 = permanent && !lineItem?.nonInventory ? (lineItem?.gtin13 ?? null) : null;
  const [sameExpense, siblings] = gtin13
    ? await Promise.all([
        expenseRepo.listSameExpenseUnassignedApprovalsByGtin13(expenseId, gtin13, approvalId),
        expenseRepo.listSiblingApprovals(expense.orgId, gtin13, expenseId),
      ])
    : [[], []];
  const assigned = { ownerId, status: "pending", decidedAt: new Date(), decidedByUserId: actor.userId };

  await db.$transaction(async (tx) => {
    // Sorted, so two assignments touching the same expenses lock them in the same order.
    for (const id of [...new Set([expenseId, ...siblings.map((s) => s.expenseId)])].sort()) await lockExpense(tx, id);
    await transition(tx, approval, assigned);
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
  const { approval } = await loadApproval(expenseId, approvalId);
  requireStatus(approval, "unknown");

  await db.$transaction(async (tx) => {
    await lockExpense(tx, expenseId);
    await transition(tx, approval, { ownerId, status: "pending", decidedAt: new Date(), decidedByUserId: actor.userId });
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
