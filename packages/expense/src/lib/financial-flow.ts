import { db } from "../db";
import { createPartOwnerRepository } from "../repositories/partOwner";
import { getExpenseRuntime } from "../runtime";
import { checkAndProcessExpense } from "./expense-qb-processor";
import { classifyCapital, isTerminalApproval, anyRejected } from "./expense-rules";
import { advanceWorkflow, advanceWorkflowInTx, unlessRaceLost, type Actor } from "./workflow-engine";
import { SYSTEM_ACTOR } from "./system-actor";
import { logError } from "./logger";

const partOwners = createPartOwnerRepository(db);

/** Buckets a line may be assigned to: listed by the host, not archived. */
export async function liveBucketIds(): Promise<Set<number>> {
  return new Set((await getExpenseRuntime().budgetOwners.list()).filter((b) => !b.archivedAt).map((b) => b.id));
}

/** Creates the line approvals and leaves `pending`. A no-op when another call already started the flow. */
export async function initFinancialFlow(expenseId: string, orgId: string, backfill = false): Promise<void> {
  const lineItems = await db.expenseLineItem.findMany({ where: { expenseId } });

  // Resolve owners before opening a transaction. Outside backfill, a mapped bucket that is no
  // longer live leaves the line unresolved, for FINANCE to assign. A non-inventory line has no part
  // to map, so FINANCE always assigns it.
  const resolvedOwners = new Map<number, number | null>();
  const live = await liveBucketIds();
  for (const li of lineItems) {
    const mapped = li.gtin13 && !li.nonInventory ? await partOwners.resolveItemOwner(orgId, li.gtin13) : null;
    resolvedOwners.set(li.id, mapped !== null && (backfill || live.has(mapped)) ? mapped : null);
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
      // Every line, an org-level one included, waits for its approval; a backfill takes none.
      await tx.lineItemOwnerApproval.create({
        data: {
          expenseId,
          lineItemId: li.id,
          ownerId: resolvedOwners.get(li.id) ?? null,
          status: backfill ? "approved" : "pending",
          decidedAt: backfill ? now : null,
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
    const moved = await advanceWorkflow({
      db,
      expenseId,
      currentState: "assign_ownership",
      event: { type: "ALL_OWNERS_ASSIGNED" },
      actor,
      action: "state_transition",
    }).catch(unlessRaceLost);
    if (moved === null) return;
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
  }).catch(unlessRaceLost);

  if (nextState === "qb_pending") await drainExpense(expense.orgId, expenseId);
}

/** Drain-on-commit: run the QB step in the request that reached qb_pending. Never throws. */
export async function drainExpense(orgId: string, expenseId: string): Promise<void> {
  await checkAndProcessExpense(orgId, expenseId).catch((err) =>
    logError("qb_trigger_failed", { expenseId, orgId }, err),
  );
}
