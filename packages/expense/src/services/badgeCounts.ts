// Counts for the host's nav pills: "Expense approvals" (lines awaiting the caller's sign-off) and
// each expense list view's items the caller can act on. The finance queue counts itself
// (financeQueueService). Each reads only the caller's own scope.
import { db } from "../db";
import type { ExpensePrincipal } from "../contract";
import { getExpenseRuntime, getOrgId } from "../runtime";
import { callerId } from "../lib/caller";
import type { Expense, Prisma } from "../generated/prisma/client";
import { EXPENSE_ACTION_VIEWS, type ExpenseActionView } from "../nav";
import { logError } from "../lib/logger";
import { CLOSED_STATES, availableSigners, boardAuthorizationRefusal, missingSeats, reimburseeUnknown } from "../lib/signoff";
import { boardApprovalNeeded, conflictedParties, filledSeatsByLine, signoffFactsByLine } from "../lib/signoff-facts";

/** The most open expenses one badge poll examines, so a poll costs a fixed amount of work. */
export const SIGNOFF_BADGE_EXPENSE_CAP = 25;

/**
 * Lines in the caller's buckets with an open program-approver seat the caller may sign, across at
 * most SIGNOFF_BADGE_EXPENSE_CAP candidate expenses (newest first); past the cap it is a lower bound.
 * The query keeps only expenses with a line in the caller's buckets whose program-approver seat is
 * open and which the caller has not signed; conflicts and Board substitution are checked per line.
 */
export async function signoffsAwaitingCount(principal: ExpensePrincipal): Promise<number> {
  const me = callerId(principal);
  const buckets = await getExpenseRuntime().signoff.bucketsApprovedBy(me);
  if (buckets.length === 0) return 0;
  const expenses = await db.expense.findMany({
    where: {
      orgId: await getOrgId(),
      backfill: false,
      state: { notIn: [...CLOSED_STATES] },
      // A reimbursement with no reimbursee takes no sign-off (reimburseeUnknown).
      NOT: { needsReimbursement: true, reimburseePersonId: null },
      submitterId: { not: me },
      approvals: {
        some: {
          ownerId: { in: buckets },
          lineItem: { signoffs: { none: { OR: [{ seat: "PROGRAM_APPROVER" }, { signerUserId: me }] } } },
        },
      },
    },
    orderBy: { submittedAt: "desc" },
    take: SIGNOFF_BADGE_EXPENSE_CAP,
  });
  let count = 0;
  for (const expense of expenses) {
    const [facts, filled] = await Promise.all([signoffFactsByLine(db, expense, { readOnly: true }), filledSeatsByLine(db, expense.id)]);
    for (const [lineId, f] of facts) {
      const seats = filled.get(lineId) ?? [];
      if (missingSeats(f, seats).includes("PROGRAM_APPROVER") && availableSigners(f, seats, "PROGRAM_APPROVER").includes(me)) count++;
    }
  }
  return count;
}

type Parties = { submitterId: number; reimburseePersonId: number | null };
const PARTIES = { submitterId: true, reimburseePersonId: true } as const;

/** Whether the caller is conflicted on an expense's parties, asking conflictedParties once per distinct pair. */
export function conflictCheck(me: number): (e: Parties) => Promise<boolean> {
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
 * Board counts; a bucket approver's own program-approver seat is signoffsAwaitingCount's.
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
