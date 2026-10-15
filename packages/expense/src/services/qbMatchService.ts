// Expense's side of match-before-create (QB-2). The shared find-or-create in
// @inventory/quickbooks is stateless; expense hands it the takeover line and the ids it must skip.
import { db, isUniqueConstraintError, type Db } from "../db";
import type { ExpensePrincipal, QbTxn } from "../contract";
import { getExpenseRuntime, getOrgId } from "../runtime";
import { writeAudit } from "../lib/audit";
import { actorOf } from "../lib/caller";
import { lockExpense, unsignedLines } from "../lib/signoff-facts";
import { reimburseeUnknown } from "../lib/signoff";
import { requireFinance } from "./approvalService";
import { ServiceError } from "./serviceError";

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
   * Receipt date of the newest line matched to a QuickBooks entry the app did not create.
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
      where: { orgId, receiptDate: { not: null }, lineItems: { some: { qbMatchState: "MATCHED" } } },
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

/** Line states that may still be linked to an existing QuickBooks entry. */
const MATCHABLE_STATES = new Set(["UNMATCHED", "AMBIGUOUS", "BEFORE_LINE", "POST_FAILED"]);

async function candidatesFor(line: Awaited<ReturnType<typeof loadLine>>): Promise<{ entity: QbMatchEntity; txns: QbTxn[] }> {
  const entity: QbMatchEntity = line.expense.needsReimbursement ? "Bill" : "Purchase";
  const date = line.expense.receiptDate;
  if (!date) return { entity, txns: [] };
  const from = shiftDate(date, -MATCH_WINDOW_DAYS);
  const to = shiftDate(date, MATCH_WINDOW_DAYS);
  const { reader, refs } = getExpenseRuntime().quickbooks;
  const personId = line.expense.reimburseePersonId;
  const expectedRef =
    entity === "Bill" ? (personId === null ? null : await refs.vendorIdFor(personId)) : await refs.paymentAccountId();
  if (expectedRef === null) return { entity, txns: [] };
  const txns = entity === "Bill" ? await reader.billsBetween(from, to) : await reader.purchasesBetween(from, to);
  const skip = new Set((await qbMatchInputs(entity)).skipIds);
  const matches = (t: QbTxn) =>
    t.totalCents === line.totalPriceCents &&
    t.txnDate >= from &&
    t.txnDate <= to &&
    (entity === "Bill" ? t.vendorRef : t.accountRef) === expectedRef &&
    !skip.has(t.id);
  return { entity, txns: txns.filter(matches) };
}

/**
 * QuickBooks entries a line may match: a Bill for a reimbursement, else a Purchase, of the
 * line's amount, inside the window around its receipt date, booked against the expected vendor
 * or payment account, never claimed or excluded.
 */
export async function qbCandidates(principal: ExpensePrincipal, lineItemId: number): Promise<QbTxn[]> {
  requireFinance(principal);
  return (await candidatesFor(await loadLine(lineItemId))).txns;
}

/**
 * Finance links a line to an existing QuickBooks entry; an entry is claimed once across expenses and lines.
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
      if (!(await claimQbTxn(tx, expense.orgId, entity, qbTxnId))) throw new ServiceError(409, "That QuickBooks entry is already claimed");
      await writeAudit(tx, actor, { expenseId: line.expenseId, action: "qb_matched", lineItemId, fieldChanged: "qbTxnId", valueAfter: qbTxnId });
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) throw new ServiceError(409, "That QuickBooks entry is already claimed by another line");
    throw err;
  }
}
