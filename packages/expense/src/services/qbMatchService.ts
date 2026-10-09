// Expense's side of match-before-create (QB-2). The shared find-or-create in
// @inventory/quickbooks is stateless; expense hands it the takeover line and the ids it must skip.
import { db, isUniqueConstraintError } from "../db";
import type { ExpensePrincipal } from "../contract";
import { getOrg } from "../runtime";
import { actorOf } from "../lib/caller";
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
  const orgId = getOrg().id;
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
      data: { orgId: getOrg().id, qbTxnId, reason: reason.trim(), excludedByUserId: actor.userId, excludedByUsername: actor.username },
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) throw new ServiceError(409, "Already excluded");
    throw err;
  }
}
