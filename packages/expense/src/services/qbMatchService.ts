// Expense's side of match-before-create (QB-2). The shared find-or-create in
// @inventory/quickbooks is stateless; expense hands it the takeover line and the ids it must skip.
import { db, isUniqueConstraintError } from "../db";
import type { ExpensePrincipal, QbTxn } from "../contract";
import { getExpenseRuntime, getOrgId } from "../runtime";
import { writeAudit } from "../lib/audit";
import { actorOf } from "../lib/caller";
import { lockExpense, unsignedLines } from "../lib/signoff-facts";
import { reimburseeUnknown } from "../lib/signoff";
import { requireFinance } from "./approvalService";
import { ServiceError } from "./serviceError";

export interface QbMatchInputs {
  /** QuickBooks ids already claimed by a line or excluded by finance: never a candidate. */
  skipIds: string[];
  /**
   * Receipt date of the newest line matched to a QuickBooks entry the app did not create.
   * Null when there is none yet: then nothing is created (fail closed).
   */
  takeoverDate: string | null;
}

export async function qbMatchInputs(): Promise<QbMatchInputs> {
  const orgId = await getOrgId();
  const [claimed, excluded, newestMatched] = await Promise.all([
    db.expenseLineItem.findMany({ where: { qbTxnId: { not: null }, expense: { orgId } }, select: { qbTxnId: true } }),
    db.expenseQbMatchExclusion.findMany({ where: { orgId }, select: { qbTxnId: true } }),
    db.expense.findFirst({
      where: { orgId, receiptDate: { not: null }, lineItems: { some: { qbMatchState: "MATCHED" } } },
      orderBy: { receiptDate: "desc" },
      select: { receiptDate: true },
    }),
  ]);
  return {
    skipIds: [...claimed.map((c) => c.qbTxnId!), ...excluded.map((e) => e.qbTxnId)],
    takeoverDate: newestMatched?.receiptDate ?? null,
  };
}

/** Finance permanently removes a QuickBooks transaction from matching, with a reason. */
export async function excludeQbTxn(principal: ExpensePrincipal, qbTxnId: string, reason: string): Promise<void> {
  requireFinance(principal);
  const actor = actorOf(principal);
  if (!reason.trim()) throw new ServiceError(400, "A reason is required");
  try {
    await db.expenseQbMatchExclusion.create({
      data: { orgId: await getOrgId(), qbTxnId, reason: reason.trim(), excludedByUserId: actor.userId, excludedByUsername: actor.username },
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) throw new ServiceError(409, "Already excluded");
    throw err;
  }
}

/** Days either side of a line's receipt date that a QuickBooks candidate may fall in. */
export const MATCH_WINDOW_DAYS = 7;

function shiftDate(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function loadLine(lineItemId: number) {
  const line = await db.expenseLineItem.findFirst({
    where: { id: lineItemId, expense: { orgId: await getOrgId() } },
    include: { expense: true },
  });
  if (!line) throw new ServiceError(404, "Line item not found");
  return line;
}

/** A reimbursement matches a Bill; every other line matches a Purchase. */
export type QbMatchEntity = "Bill" | "Purchase";

/** Line states that may still be linked to an existing QuickBooks entry. */
const MATCHABLE_STATES = new Set(["UNMATCHED", "AMBIGUOUS", "BEFORE_LINE", "POST_FAILED"]);

async function candidatesFor(line: Awaited<ReturnType<typeof loadLine>>): Promise<{ entity: QbMatchEntity; txns: QbTxn[] }> {
  const entity: QbMatchEntity = line.expense.needsReimbursement ? "Bill" : "Purchase";
  const date = line.expense.receiptDate;
  if (!date) return { entity, txns: [] };
  const from = shiftDate(date, -MATCH_WINDOW_DAYS);
  const to = shiftDate(date, MATCH_WINDOW_DAYS);
  const reader = getExpenseRuntime().quickbooks.reader;
  const txns = entity === "Bill" ? await reader.billsBetween(from, to) : await reader.purchasesBetween(from, to);
  const skip = new Set((await qbMatchInputs()).skipIds);
  const inWindow = (t: QbTxn) => t.txnDate >= from && t.txnDate <= to;
  return { entity, txns: txns.filter((t) => t.totalCents === line.totalPriceCents && inWindow(t) && !skip.has(t.id)) };
}

/**
 * QuickBooks entries a line may match: a Bill for a reimbursement, else a Purchase, of the
 * line's amount, inside the window around its receipt date, never claimed or excluded.
 */
export async function qbCandidates(principal: ExpensePrincipal, lineItemId: number): Promise<QbTxn[]> {
  requireFinance(principal);
  return (await candidatesFor(await loadLine(lineItemId))).txns;
}

/**
 * Finance links a line to an existing QuickBooks entry; an entry is claimed by one line at most.
 * The entry must be one of the line's own candidates, and the line fully signed off.
 */
export async function matchLineToQb(principal: ExpensePrincipal, lineItemId: number, qbTxnId: string): Promise<void> {
  requireFinance(principal);
  const actor = actorOf(principal);
  const line = await loadLine(lineItemId);
  if (line.qbTxnId) throw new ServiceError(409, "Line is already linked to QuickBooks");
  if (!MATCHABLE_STATES.has(line.qbMatchState) || line.expense.state === "rejected") {
    throw new ServiceError(409, "Line is not in a state that can be matched");
  }
  const { entity, txns } = await candidatesFor(line);
  if (!txns.some((t) => t.id === qbTxnId)) throw new ServiceError(409, "That QuickBooks entry is not a candidate for this line");
  try {
    await db.$transaction(async (tx) => {
      // Sign-offs are read under the expense lock, so a concurrent void cannot slip past the check.
      await lockExpense(tx, line.expenseId);
      const expense = (await tx.expense.findUnique({ where: { id: line.expenseId } }))!;
      if (!expense.backfill && (reimburseeUnknown(expense) || (await unsignedLines(tx, expense)).has(lineItemId))) {
        throw new ServiceError(409, "Line is missing a required sign-off");
      }
      const linked = await tx.expenseLineItem.updateMany({
        where: { id: lineItemId, qbTxnId: null, qbMatchState: { in: [...MATCHABLE_STATES] } },
        data: { qbMatchState: "MATCHED", qbTxnId, qbTxnEntity: entity },
      });
      if (linked.count === 0) throw new ServiceError(409, "Line is already linked to QuickBooks");
      await writeAudit(tx, actor, { expenseId: line.expenseId, action: "qb_matched", lineItemId, fieldChanged: "qbTxnId", valueAfter: qbTxnId });
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) throw new ServiceError(409, "That QuickBooks entry is already claimed by another line");
    throw err;
  }
}
