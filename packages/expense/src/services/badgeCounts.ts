// Counts for the host's nav pills: Expense Ops (holds + open flags), "Expense approvals" (lines
// awaiting the caller's sign-off), and each expense list view's items the caller can act on.
// Each reads only the caller's own scope.
import { db } from "../db";
import type { ExpensePrincipal } from "../contract";
import { getExpenseRuntime, getOrgId } from "../runtime";
import { callerId } from "../lib/caller";
import type { Expense } from "../generated/prisma/client";
import type { ExpenseActionView } from "../nav";
import { CLOSED_STATES, availableSigners, boardAuthorizationRefusal, missingSeats, reimburseeUnknown, signoffRefusal } from "../lib/signoff";
import { boardApprovalNeeded, conflictedParties, filledSeatsByLine, signoffFactsByLine } from "../lib/signoff-facts";
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
    const [facts, filled] = await Promise.all([signoffFactsByLine(db, expense), filledSeatsByLine(db, expense.id)]);
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
 * Per expense list view, what the caller can act on. Assigning buckets, settling exceptions,
 * capital review and depreciation are FINANCE steps; owner approval counts pending lines in the
 * caller's own buckets. Steps the server refuses a conflicted caller leave those expenses out;
 * capital review and depreciation are bookkeeping any FINANCE holder may do, so they keep them.
 * Expenses and lines a viewer can act on in QB pending are counted by qbPendingActionCount.
 */
export async function expenseActionCounts(principal: ExpensePrincipal): Promise<Record<ExpenseActionView, number>> {
  const me = callerId(principal);
  const orgId = await getOrgId();
  const conflicted = conflictCheck(me);
  const finance = principal.isFinance;
  const buckets = await getExpenseRuntime().signoff.bucketsApprovedBy(me);
  const [assign, approval, exceptions, capital, depreciation, qbPending] = await Promise.all([
    finance
      ? db.expense.findMany({ where: { orgId, state: "assign_ownership", approvals: { some: { ownerId: null } } }, select: PARTIES })
      : [],
    buckets.length > 0
      ? db.lineItemOwnerApproval.findMany({
          where: { status: "pending", ownerId: { in: buckets }, expense: { orgId, state: "owner_approval" } },
          select: { expense: { select: PARTIES } },
        })
      : [],
    finance
      ? db.expense.findMany({ where: { orgId, state: "owner_approval", approvals: { some: { status: "exception_raised" } } }, select: PARTIES })
      : [],
    finance ? db.expense.count({ where: { orgId, state: "capital_review" } }) : 0,
    finance ? db.expense.count({ where: { orgId, state: "set_depreciation_cycle" } }) : 0,
    finance || principal.isBoard ? qbPendingActionCount(principal) : 0,
  ]);
  return {
    assign_ownership: await countFree(assign, conflicted),
    owner_approval: await countFree(approval.map((a) => a.expense), conflicted),
    owner_exception: await countFree(exceptions, conflicted),
    capital_review: capital,
    set_depreciation_cycle: depreciation,
    qb_pending: qbPending,
  };
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
    signoffFactsByLine(db, expense),
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
