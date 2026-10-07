import { db } from "../db";
import { createPartOwnerRepository } from "../repositories/partOwner";
import { getExpenseRuntime } from "../runtime";
import { checkAndProcessExpense } from "./expense-qb-processor";
import { classifyCapital, isTerminalApproval, anyRejected } from "./expense-rules";
import { advanceWorkflow, advanceWorkflowInTx, type Actor } from "./workflow-engine";
import { SYSTEM_ACTOR } from "./system-actor";
import { logError } from "./logger";

const partOwners = createPartOwnerRepository(db);

/** Finance assigning a line to an org-level bucket is the approval; a program bucket waits for its approvers. */
export async function isOrgLevelBucket(bucketId: number): Promise<boolean> {
  return (await getExpenseRuntime().signoff.bucketApprovers(bucketId)).orgLevel;
}

/** Creates the line approvals and leaves `pending`. A no-op when another call already started the flow. */
export async function initFinancialFlow(expenseId: string, orgId: string, backfill = false): Promise<void> {
  const lineItems = await db.expenseLineItem.findMany({ where: { expenseId } });

  // Resolve owners and their bucket kind before opening a transaction.
  const resolvedOwners = new Map<number, number | null>();
  const orgLevel = new Map<number, boolean>();
  for (const li of lineItems) {
    const ownerId = li.gtin13 ? await partOwners.resolveItemOwner(orgId, li.gtin13) : null;
    resolvedOwners.set(li.id, ownerId);
    if (ownerId !== null && !orgLevel.has(ownerId)) orgLevel.set(ownerId, await isOrgLevelBucket(ownerId));
  }

  // Backfill: owner re-signoff is skipped (already approved historically) — treat owners as resolved
  // and pre-approve every line so the flow advances straight through owner_approval.
  const allHaveOwners = backfill || (lineItems.length > 0 && lineItems.every((li) => resolvedOwners.get(li.id) !== null));
  const event = { type: "FLOW_STARTED" as const, allOwnersResolved: allHaveOwners };
  const now = new Date();

  // Approval creation and state transition are atomic: either both land or neither does.
  await db.$transaction(async (tx) => {
    // Row-locking claim on the pending expense: a concurrent caller waits here, then finds it started.
    const claimed = await tx.expense.updateMany({ where: { id: expenseId, state: "pending" }, data: { state: "pending" } });
    if (claimed.count === 0) return;
    for (const li of lineItems) {
      const ownerId = resolvedOwners.get(li.id) ?? null;
      const preApproved = backfill || (ownerId !== null && orgLevel.get(ownerId) === true);
      await tx.lineItemOwnerApproval.create({
        data: {
          expenseId,
          lineItemId: li.id,
          ownerId,
          status: preApproved ? "approved" : "pending",
          decidedAt: preApproved ? now : null,
          notes: backfill ? "backfill: already booked in QuickBooks" : null,
        },
      });
    }
    await advanceWorkflowInTx(tx, {
      expenseId,
      currentState: "pending",
      event,
      actor: SYSTEM_ACTOR,
      action: "financial_flow_started",
    });
  });
}

export async function checkOwnershipAutoTransition(expenseId: string, actor: Actor): Promise<void> {
  const expense = await db.expense.findFirst({ where: { id: expenseId } });
  if (!expense || expense.state !== "assign_ownership") return;

  const approvals = await db.lineItemOwnerApproval.findMany({ where: { expenseId } });

  const allHaveOwners = approvals.length > 0 && approvals.every((a) => a.ownerId !== null);
  const hasUnknowns = approvals.some((a) => a.status === "unknown");

  if (allHaveOwners && !hasUnknowns) {
    await advanceWorkflow({
      db,
      expenseId,
      currentState: "assign_ownership",
      event: { type: "ALL_OWNERS_ASSIGNED" },
      actor,
      action: "state_transition",
    });
    // Lines finance assigned to org-level buckets may already be approved.
    await checkApprovalAutoTransition(expenseId, actor);
  }
}

export async function checkApprovalAutoTransition(expenseId: string, actor: Actor): Promise<void> {
  const expense = await db.expense.findFirst({ where: { id: expenseId } });
  if (!expense || expense.state !== "owner_approval") return;

  const approvals = await db.lineItemOwnerApproval.findMany({ where: { expenseId } });

  if (approvals.length === 0) return;

  const allTerminal = approvals.every((a) => isTerminalApproval(a.status));
  if (!allTerminal) return;

  const org = await db.expenseOrgSettings.findFirst({ where: { orgId: expense.orgId } });

  const lineItems = await db.expenseLineItem.findMany({ where: { expenseId } });

  const hasCapital = classifyCapital(expense.receiptTotalCents, lineItems, org);
  const rejected = anyRejected(approvals);
  const event = { type: "ALL_APPROVALS_TERMINAL" as const, hasCapital, anyRejected: rejected };
  const context = { hasCapital };

  const nextState = await advanceWorkflow({
    db,
    expenseId,
    currentState: "owner_approval",
    event,
    context,
    actor,
    action: "state_transition",
  });

  if (nextState === "qb_pending") await drainExpense(expense.orgId, expenseId);
}

/** Drain-on-commit: run the QB step in the request that reached qb_pending. Never throws. */
export async function drainExpense(orgId: string, expenseId: string): Promise<void> {
  await checkAndProcessExpense(orgId, expenseId).catch((err) =>
    logError("qb_trigger_failed", { expenseId, orgId }, err),
  );
}
