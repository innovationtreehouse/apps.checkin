// Counts for the host's nav pills: "Expense approvals" (lines waiting on the caller's approval,
// the program approver's sign-off) and each expense list view's items the caller can act on. The
// finance queue counts itself (financeQueueService). Each reads only the caller's own scope.
import { db } from "../db";
import type { ExpensePrincipal } from "../contract";
import { getExpenseRuntime, getOrgId } from "../runtime";
import { callerId } from "../lib/caller";
import type { Expense, Prisma } from "../generated/prisma/client";
import { EXPENSE_ACTION_VIEWS, type ExpenseActionView } from "../nav";
import { logError } from "../lib/logger";
import { boardAuthorizationRefusal, reimburseeUnknown } from "../lib/signoff";
import { boardApprovalNeeded, conflictedParties, signoffFactsByLine } from "../lib/signoff-facts";
import { APPROVABLE_STATUSES } from "./approvalService";
import { callerLines } from "./signoffService";

/** The most expenses a sign-off badge or list reports for one caller. */
export const SIGNOFF_BADGE_EXPENSE_CAP = 25;

/** The most candidate expenses one approval-badge poll examines, so a poll's work has a fixed bound. */
export const SIGNOFF_BADGE_CANDIDATE_CAP = 2 * SIGNOFF_BADGE_EXPENSE_CAP;

export interface ExpenseAwaitingApproval {
  expenseId: string;
  /** The lines whose main act for the caller is approval. */
  lineItemIds: number[];
}

/**
 * The expenses waiting on the caller's approval, each with the lines whose main act for the
 * caller (from lineActions) is approval: the SIGNOFF_BADGE_EXPENSE_CAP newest such expenses among
 * the SIGNOFF_BADGE_CANDIDATE_CAP newest candidates. Candidates are expenses in owner approval, not
 * the caller's own receipt and not a reimbursement with no reimbursee (the approve service refuses
 * both), with a line waiting for approval in the caller's buckets, or in any bucket for a Board
 * member. Past either cap the result is a lower bound: it never lists a line the caller cannot
 * approve, but leaves out work older than the candidates read. The approver pill, its "Waiting on
 * you" view and the owner-approval view count all read this.
 */
export async function expensesAwaitingMyApproval(principal: ExpensePrincipal): Promise<ExpenseAwaitingApproval[]> {
  const me = callerId(principal);
  const buckets = await getExpenseRuntime().signoff.bucketsApprovedBy(me);
  if (buckets.length === 0 && !principal.isBoard) return [];
  const where: Prisma.ExpenseWhereInput = {
    orgId: await getOrgId(),
    backfill: false,
    state: "owner_approval",
    submitterId: { not: me },
    NOT: { needsReimbursement: true, reimburseePersonId: null },
    approvals: { some: { status: { in: [...APPROVABLE_STATUSES] }, ...(principal.isBoard ? {} : { ownerId: { in: buckets } }) } },
  };
  const candidates = await db.expense.findMany({ where, orderBy: [{ submittedAt: "desc" }, { id: "asc" }], take: SIGNOFF_BADGE_CANDIDATE_CAP });
  const out: ExpenseAwaitingApproval[] = [];
  for (const expense of candidates) {
    if (out.length === SIGNOFF_BADGE_EXPENSE_CAP) break;
    const lineItemIds = (await callerLines(principal, expense, true))
      .filter((line) => line.actions.some((a) => a.act === "approve" && a.primary))
      .map((line) => line.lineItemId);
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
 * exceptions, capital review and depreciation are FINANCE steps; owner approval counts the
 * expenses waiting on the caller's approval (expensesAwaitingMyApproval). Steps the server
 * refuses a conflicted caller leave those expenses out; capital review and depreciation are
 * bookkeeping any FINANCE holder may do, so they keep them. A view whose count fails is logged
 * and left out, so the others still show.
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
 * SIGNOFF_BADGE_EXPENSE_CAP of them (newest first): set an unknown reimbursee (FINANCE) or record
 * the Board authorization. Treasurer and Board signatures are the finance queue's To sign and
 * Board counts; a line's approval, the program approver's sign-off, is signoffsAwaitingCount's.
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
