// Counts for the host's nav pills: Expense Ops (holds + open flags), "Expense approvals" (lines
// awaiting the caller's approval, the program approver's sign-off), and each expense list view's
// items the caller can act on. Each reads only the caller's own scope.
import { db } from "../db";
import type { ExpensePrincipal } from "../contract";
import { getExpenseRuntime, getOrgId } from "../runtime";
import { callerId } from "../lib/caller";
import type { Expense, Prisma } from "../generated/prisma/client";
import { EXPENSE_ACTION_VIEWS, type ExpenseActionView } from "../nav";
import { logError } from "../lib/logger";
import { approvalRefusal, boardAuthorizationRefusal, reimburseeUnknown } from "../lib/signoff";
import { boardApprovalNeeded, conflictedParties, filledSeatsByLine, signoffFactsByLine } from "../lib/signoff-facts";
import { listOpenFlags } from "./flagService";
import { APPROVABLE_STATUSES } from "./approvalService";

/**
 * Expenses with a pending account hold, for FINANCE only (only FINANCE sets the account and
 * resubmits), and flags open to the caller's audience (FINANCE, Board).
 */
export async function expenseOpsCounts(principal: ExpensePrincipal): Promise<{ holds: number; openFlags: number }> {
  if (!principal.isFinance && !principal.isBoard) return { holds: 0, openFlags: 0 };
  const [holds, flags] = await Promise.all([
    principal.isFinance ? db.expense.count({ where: { orgId: await getOrgId(), holds: { some: { status: "PENDING" } } } }) : 0,
    listOpenFlags(principal),
  ]);
  return { holds, openFlags: flags.length };
}

/** The most open expenses one badge poll examines, so a poll costs a fixed amount of work. */
export const SIGNOFF_BADGE_EXPENSE_CAP = 25;

/**
 * Lines in the caller's buckets waiting for an approval the caller may give, across at most
 * SIGNOFF_BADGE_EXPENSE_CAP candidate expenses (newest first); past the cap it is a lower bound.
 * The query keeps expenses in owner approval with such a line, not submitted by the caller; the
 * approval's refusals are checked per line.
 */
export async function signoffsAwaitingCount(principal: ExpensePrincipal): Promise<number> {
  const me = callerId(principal);
  const buckets = await getExpenseRuntime().signoff.bucketsApprovedBy(me);
  if (buckets.length === 0) return 0;
  const waiting = { ownerId: { in: buckets }, status: { in: [...APPROVABLE_STATUSES] } };
  const expenses = await db.expense.findMany({
    where: { orgId: await getOrgId(), backfill: false, state: "owner_approval", submitterId: { not: me }, approvals: { some: waiting } },
    orderBy: { submittedAt: "desc" },
    take: SIGNOFF_BADGE_EXPENSE_CAP,
  });
  let count = 0;
  for (const expense of expenses) {
    const [facts, filled, approvals] = await Promise.all([
      signoffFactsByLine(db, expense, { readOnly: true }),
      filledSeatsByLine(db, expense.id),
      db.lineItemOwnerApproval.findMany({ where: { expenseId: expense.id, ...waiting }, select: { lineItemId: true } }),
    ]);
    for (const { lineItemId } of approvals) {
      if (approvalRefusal(facts.get(lineItemId)!, filled.get(lineItemId) ?? [], me) === null) count++;
    }
  }
  return count;
}

type Parties = { submitterId: number; reimburseePersonId: number | null };
const PARTIES = { submitterId: true, reimburseePersonId: true } as const;

/** Whether the caller is conflicted on an expense's parties, asking conflictedParties once per distinct pair. */
function conflictCheck(me: number): (e: Parties) => Promise<boolean> {
  const seen = new Map<string, Promise<boolean>>();
  return (e) => {
    const key = `${e.submitterId}:${e.reimburseePersonId}`;
    if (!seen.has(key)) seen.set(key, conflictedParties(e).then((parties) => parties.includes(me)));
    return seen.get(key)!;
  };
}

async function countFree(rows: Parties[], conflicted: (e: Parties) => Promise<boolean>): Promise<number> {
  return (await Promise.all(rows.map(conflicted))).filter((c) => !c).length;
}

/**
 * Per expense list view, the expenses the caller can act on. Assigning buckets, settling
 * exceptions, capital review and depreciation are FINANCE steps; owner approval counts expenses
 * with a pending line in the caller's own buckets. Steps the server refuses a conflicted caller
 * leave those expenses out; capital review and depreciation are bookkeeping any FINANCE holder
 * may do, so they keep them. A view whose count fails is logged and left out, so the others
 * still show.
 */
export async function expenseActionCounts(principal: ExpensePrincipal): Promise<Partial<Record<ExpenseActionView, number>>> {
  const me = callerId(principal);
  const orgId = await getOrgId();
  const conflicted = conflictCheck(me);
  const finance = principal.isFinance;
  const free = async (where: Prisma.ExpenseWhereInput) =>
    countFree(await db.expense.findMany({ where: { orgId, ...where }, select: PARTIES }), conflicted);
  const tasks: Record<ExpenseActionView, () => Promise<number>> = {
    assign_ownership: async () => (finance ? free({ state: "assign_ownership", approvals: { some: { ownerId: null } } }) : 0),
    owner_approval: async () => {
      const buckets = await getExpenseRuntime().signoff.bucketsApprovedBy(me);
      if (buckets.length === 0) return 0;
      return free({ state: "owner_approval", approvals: { some: { status: "pending", ownerId: { in: buckets } } } });
    },
    // An exception is not terminal, so it holds its expense in owner_approval, where FINANCE settles it.
    owner_exception: async () => (finance ? free({ approvals: { some: { status: "exception_raised" } } }) : 0),
    capital_review: async () => (finance ? db.expense.count({ where: { orgId, state: "capital_review" } }) : 0),
    set_depreciation_cycle: async () => (finance ? db.expense.count({ where: { orgId, state: "set_depreciation_cycle" } }) : 0),
    qb_pending: async () => (finance || principal.isBoard ? qbPendingActionCount(principal) : 0),
  };
  const settled = await Promise.all(
    EXPENSE_ACTION_VIEWS.map(async (view) => {
      try {
        return [view, await tasks[view]()] as const;
      } catch (err) {
        logError("expense_action_count_failed", { view }, err);
        return null;
      }
    }),
  );
  return Object.fromEntries(settled.filter((r) => r !== null));
}

/**
 * QB pending expenses the caller can move toward QuickBooks, across at most
 * SIGNOFF_BADGE_EXPENSE_CAP of them (newest first): set an unknown reimbursee (FINANCE) or record
 * the Board authorization. Treasurer and Board signatures are the finance queue's To sign and
 * Board counts; the line's approval is signoffsAwaitingCount's.
 */
export async function qbPendingActionCount(principal: ExpensePrincipal): Promise<number> {
  const me = callerId(principal);
  const expenses = await db.expense.findMany({
    where: { orgId: await getOrgId(), state: "qb_pending", backfill: false, submitterId: { not: me } },
    orderBy: { submittedAt: "desc" },
    take: SIGNOFF_BADGE_EXPENSE_CAP,
  });
  let count = 0;
  for (const expense of expenses) if (await canMoveQbPending(principal, me, expense)) count++;
  return count;
}

async function canMoveQbPending(principal: ExpensePrincipal, me: number, expense: Expense): Promise<boolean> {
  if (reimburseeUnknown(expense)) return principal.isFinance && !(await conflictedParties(expense)).includes(me);
  const [facts, approvalNeeded] = await Promise.all([signoffFactsByLine(db, expense, { readOnly: true }), boardApprovalNeeded(db, expense)]);
  const lines = [...facts.values()];
  const takesAuthorization = expense.boardAuthorization === null && (approvalNeeded || lines.some((f) => f.boardSeat));
  return takesAuthorization && boardAuthorizationRefusal(lines, me) === null;
}
