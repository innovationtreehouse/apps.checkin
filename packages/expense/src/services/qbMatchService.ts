// Expense's side of match-before-create (QB-2). The shared find-or-create in
// @checkin/quickbooks is stateless; expense hands it the takeover line and the ids it must skip.
import { db, isUniqueConstraintError, type Db } from "../db";
import type { ExpensePrincipal, QbTxn } from "../contract";
import { getExpenseRuntime, getOrgId } from "../runtime";
import { writeAudit, writeOrgAudit } from "../lib/audit";
import { matchBaseline } from "../lib/expense-qb-drift";
import { actorOf } from "../lib/caller";
import { lockExpense, unsignedLines } from "../lib/signoff-facts";
import { reimburseeUnknown } from "../lib/signoff";
import { requireFinance } from "./approvalService";
import { ServiceError } from "@checkin/component-kit";

/** A reimbursement matches a Bill; every other line matches a Purchase. */
export type QbMatchEntity = "Bill" | "Purchase";

/**
 * Claims a QuickBooks entry for an expense or a line inside the caller's transaction; false when
 * it is already claimed. Never throws on a conflict, so the caller's transaction stays usable.
 */
export async function claimQbTxn(tx: Db, orgId: string, qbTxnEntity: string, qbTxnId: string): Promise<boolean> {
  const { count } = await tx.expenseQbClaim.createMany({ data: [{ orgId, qbTxnEntity, qbTxnId }], skipDuplicates: true });
  return count === 1;
}

/** QuickBooks ids of one entity type held by any expense or line. */
export async function claimedQbTxnIds(orgId: string, qbTxnEntity: string): Promise<string[]> {
  const rows = await db.expenseQbClaim.findMany({ where: { orgId, qbTxnEntity }, select: { qbTxnId: true } });
  return rows.map((r) => r.qbTxnId);
}

export interface QbMatchInputs {
  /** QuickBooks ids of the entity type already claimed by an expense or a line, or excluded by finance: never a candidate. */
  skipIds: string[];
  /**
   * Receipt date of the newest expense, or expense with a line, matched to a QuickBooks entry the app did not create.
   * Null when there is none yet: then nothing is created (fail closed).
   */
  takeoverDate: string | null;
}

export async function qbMatchInputs(entity: QbMatchEntity): Promise<QbMatchInputs> {
  const orgId = await getOrgId();
  const [claimed, excluded, newestMatched] = await Promise.all([
    claimedQbTxnIds(orgId, entity),
    db.expenseQbMatchExclusion.findMany({ where: { orgId }, select: { qbTxnId: true } }),
    db.expense.findFirst({
      where: {
        orgId,
        receiptDate: { not: null },
        OR: [{ qbMatchState: "MATCHED" }, { lineItems: { some: { qbMatchState: "MATCHED" } } }],
      },
      orderBy: { receiptDate: "desc" },
      select: { receiptDate: true },
    }),
  ]);
  return {
    skipIds: [...claimed, ...excluded.map((e) => e.qbTxnId)],
    takeoverDate: newestMatched?.receiptDate ?? null,
  };
}

/** Finance permanently removes a QuickBooks transaction from matching, with a reason. */
export async function excludeQbTxn(principal: ExpensePrincipal, qbTxnId: string, reason: string): Promise<void> {
  requireFinance(principal);
  const actor = actorOf(principal);
  if (!reason.trim()) throw new ServiceError(400, "A reason is required");
  const orgId = await getOrgId();
  try {
    await db.$transaction(async (tx) => {
      await tx.expenseQbMatchExclusion.create({
        data: { orgId, qbTxnId, reason: reason.trim(), excludedByUserId: actor.userId, excludedByUsername: actor.username },
      });
      await writeOrgAudit(tx, orgId, actor, { entityType: "qb_txn", entityId: qbTxnId, action: "excluded", after: { reason: reason.trim() } });
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

async function loadExpense(expenseId: string) {
  const expense = await db.expense.findFirst({ where: { id: expenseId, orgId: await getOrgId() }, include: { lineItems: true } });
  if (!expense) throw new ServiceError(404, "Expense not found");
  return expense;
}

/** Expense states that may still be linked to an existing QuickBooks entry. */
const MATCHABLE_STATES = ["UNMATCHED", "AMBIGUOUS", "BEFORE_LINE", "POST_FAILED", "NEEDS_FINANCE"];

/**
 * The total the poster would book: every line plus the expense's tax and shipping, less its discount.
 * Read from the expense, since line allocations are set only once the expense is processed.
 */
function postedTotalCents(expense: Awaited<ReturnType<typeof loadExpense>>): number {
  const lines = expense.lineItems.reduce((sum, l) => sum + l.totalPriceCents, 0);
  return lines + expense.taxCents + expense.shippingCents - expense.discountCents;
}

async function candidatesFor(expense: Awaited<ReturnType<typeof loadExpense>>): Promise<{ entity: QbMatchEntity; txns: QbTxn[] }> {
  const entity: QbMatchEntity = expense.needsReimbursement ? "Bill" : "Purchase";
  const date = expense.receiptDate;
  if (!date) return { entity, txns: [] };
  const from = shiftDate(date, -MATCH_WINDOW_DAYS);
  const to = shiftDate(date, MATCH_WINDOW_DAYS);
  const { reader, refs } = getExpenseRuntime().quickbooks;
  const personId = expense.reimburseePersonId;
  const expectedRef =
    entity === "Bill" ? (personId === null ? null : await refs.vendorIdFor(personId)) : await refs.paymentAccountId();
  if (expectedRef === null) return { entity, txns: [] };
  const txns = entity === "Bill" ? await reader.billsBetween(from, to) : await reader.purchasesBetween(from, to);
  const skip = new Set((await qbMatchInputs(entity)).skipIds);
  const totalCents = postedTotalCents(expense);
  const matches = (t: QbTxn) =>
    t.totalCents === totalCents &&
    t.txnDate >= from &&
    t.txnDate <= to &&
    (entity === "Bill" ? t.vendorRef : t.accountRef) === expectedRef &&
    !skip.has(t.id);
  return { entity, txns: txns.filter(matches) };
}

/**
 * QuickBooks entries an expense may match: a Bill for a reimbursement, else a Purchase, of the
 * total the poster would book, inside the window around its receipt date, booked against the
 * expected vendor or payment account, never claimed or excluded.
 */
export async function qbCandidates(principal: ExpensePrincipal, expenseId: string): Promise<QbTxn[]> {
  requireFinance(principal);
  return (await candidatesFor(await loadExpense(expenseId))).txns;
}

/**
 * Finance links an expense to an existing QuickBooks entry; an entry is claimed once across expenses and lines.
 * The entry must be one of the expense's own candidates, and every line fully signed off.
 * A matched expense holds a qbTxnId, so the poster never books it again.
 */
export async function matchExpenseToQb(principal: ExpensePrincipal, expenseId: string, qbTxnId: string): Promise<void> {
  requireFinance(principal);
  const actor = actorOf(principal);
  const expense = await loadExpense(expenseId);
  if (expense.qbTxnId) throw new ServiceError(409, "Expense is already linked to QuickBooks");
  if (!MATCHABLE_STATES.includes(expense.qbMatchState) || expense.state === "rejected" || expense.backfill) {
    throw new ServiceError(409, "Expense is not in a state that can be matched");
  }
  const { entity, txns } = await candidatesFor(expense);
  if (!txns.some((t) => t.id === qbTxnId)) throw new ServiceError(409, "That QuickBooks entry is not a candidate for this expense");
  const qbMatchBaseline = await matchBaseline(entity, qbTxnId, expense.receiptDate);
  try {
    await db.$transaction(async (tx) => {
      // Sign-offs are read under the expense lock, so a concurrent void cannot slip past the check.
      await lockExpense(tx, expenseId);
      const current = (await tx.expense.findUnique({ where: { id: expenseId } }))!;
      if (reimburseeUnknown(current) || (await unsignedLines(tx, current)).size > 0) {
        throw new ServiceError(409, "Expense is missing a required sign-off");
      }
      const linked = await tx.expense.updateMany({
        where: { id: expenseId, qbTxnId: null, qbMatchState: { in: MATCHABLE_STATES } },
        data: { qbMatchState: "MATCHED", qbTxnId, qbTxnEntity: entity, qbMatchBaseline },
      });
      if (linked.count === 0) throw new ServiceError(409, "Expense is already linked to QuickBooks");
      if (!(await claimQbTxn(tx, current.orgId, entity, qbTxnId))) throw new ServiceError(409, "That QuickBooks entry is already claimed");
      await writeAudit(tx, actor, {
        expenseId,
        action: "qb_matched",
        fieldChanged: "qbMatchState",
        valueBefore: current.qbMatchState,
        valueAfter: `MATCHED:${qbTxnId}`,
      });
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) throw new ServiceError(409, "That QuickBooks entry is already claimed by another expense");
    throw err;
  }
}
