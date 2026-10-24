// Counts for the host's nav pills: Expense Ops (holds + open flags), "Expense approvals" (lines
// waiting on the caller's approval), and each expense list view's items the caller can act on.
// Each reads only the caller's own scope.
import { db } from "../db";
import type { ExpensePrincipal } from "../contract";
import { getExpenseRuntime, getOrgId } from "../runtime";
import { callerId } from "../lib/caller";
import type { Expense, Prisma } from "../generated/prisma/client";
import { EXPENSE_ACTION_VIEWS, type ExpenseActionView } from "../nav";
import { logError } from "../lib/logger";
import { CLOSED_STATES, availableSigners, boardAuthorizationRefusal, missingSeats, reimburseeUnknown, signoffRefusal } from "../lib/signoff";
import { boardApprovalNeeded, conflictedParties, filledSeatsByLine, lineHolds, signoffFactsByLine } from "../lib/signoff-facts";
import { lineActions } from "../lib/line-actions";
import { listOpenFlags } from "./flagService";

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

export interface ExpenseAwaitingApproval {
  expenseId: string;
  /** The lines whose main act for the caller is approval. */
  lineItemIds: number[];
}

/**
 * The expenses waiting on the caller's approval, each with the lines whose main act for the
 * caller (from lineActions) is approval, across at most SIGNOFF_BADGE_EXPENSE_CAP candidate
 * expenses (newest first); past the cap it is a lower bound. The query keeps expenses in owner
 * approval, not the caller's own receipt, with a pending line in the caller's buckets, or in any
 * bucket for a Board member; lineActions decides each line. The approver pill, its "Waiting on
 * you" view and the owner-approval view count all read this.
 */
export async function expensesAwaitingMyApproval(principal: ExpensePrincipal): Promise<ExpenseAwaitingApproval[]> {
  const me = callerId(principal);
  const buckets = await getExpenseRuntime().signoff.bucketsApprovedBy(me);
  if (buckets.length === 0 && !principal.isBoard) return [];
  const expenses = await db.expense.findMany({
    where: {
      orgId: await getOrgId(),
      backfill: false,
      state: "owner_approval",
      submitterId: { not: me },
      approvals: { some: { status: "pending", ...(principal.isBoard ? {} : { ownerId: { in: buckets } }) } },
    },
    orderBy: { submittedAt: "desc" },
    take: SIGNOFF_BADGE_EXPENSE_CAP,
  });
  const caller = { id: me, isFinance: principal.isFinance };
  const out: ExpenseAwaitingApproval[] = [];
  for (const expense of expenses) {
    const [facts, filled, approvalNeeded, approvals] = await Promise.all([
      signoffFactsByLine(db, expense, { readOnly: true }),
      filledSeatsByLine(db, expense.id),
      boardApprovalNeeded(db, expense),
      db.lineItemOwnerApproval.findMany({ where: { expenseId: expense.id }, select: { lineItemId: true, status: true, ownerId: true } }),
    ]);
    const held = { state: expense.state, backfill: expense.backfill, reimburseeUnknown: reimburseeUnknown(expense) };
    const approvalOf = new Map(approvals.map((a) => [a.lineItemId, a]));
    const lineItemIds = [...facts].flatMap(([lineItemId, f]) => {
      const seats = filled.get(lineItemId) ?? [];
      const { actions } = lineActions({
        caller,
        expense: held,
        approval: approvalOf.get(lineItemId) ?? null,
        facts: f,
        filled: seats,
        holds: lineHolds(approvalNeeded, f, seats),
      });
      return actions.some((a) => a.act === "approve" && a.primary) ? [lineItemId] : [];
    });
    if (lineItemIds.length > 0) out.push({ expenseId: expense.id, lineItemIds });
  }
  return out;
}

/** The approver pill: lines waiting on the caller's approval (expensesAwaitingMyApproval). */
export async function signoffsAwaitingCount(principal: ExpensePrincipal): Promise<number> {
  return (await expensesAwaitingMyApproval(principal)).reduce((n, e) => n + e.lineItemIds.length, 0);
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
 * exceptions, capital review and depreciation are FINANCE steps; owner approval counts the
 * expenses waiting on the caller's approval (expensesAwaitingMyApproval). Steps the server refuses a conflicted caller
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
    owner_approval: async () => (await expensesAwaitingMyApproval(principal)).length,
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
 * SIGNOFF_BADGE_EXPENSE_CAP of them (newest first): set an unknown reimbursee (FINANCE), record
 * the Board authorization, or fill an open Treasurer, Board or Board-substituted program-approver
 * seat. A bucket approver's own program-approver seat is signoffsAwaitingCount's, and the
 * submitter seat is the submitter's.
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
  const [facts, filled, approvalNeeded] = await Promise.all([
    signoffFactsByLine(db, expense, { readOnly: true }),
    filledSeatsByLine(db, expense.id),
    boardApprovalNeeded(db, expense),
  ]);
  const lines = [...facts.values()];
  const takesAuthorization = expense.boardAuthorization === null && (approvalNeeded || lines.some((f) => f.boardSeat));
  if (takesAuthorization && boardAuthorizationRefusal(lines, me) === null) return true;
  for (const [lineId, f] of facts) {
    const seats = filled.get(lineId) ?? [];
    for (const seat of missingSeats(f, seats)) {
      if (seat === "SUBMITTER") continue;
      if (seat === "PROGRAM_APPROVER" && availableSigners(f, seats, seat).includes(me)) continue;
      if (signoffRefusal(f, seats, seat, me) === null) return true;
    }
  }
  return false;
}
