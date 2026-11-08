// Finance's approval of an expense's tax that no receipt finance approval covers.
import { db } from "../db";
import type { ExpensePrincipal } from "../contract";
import { getOrgId } from "../runtime";
import { actorOf } from "../lib/caller";
import { writeAudit } from "../lib/audit";
import { taxWaitsOnFinance } from "../lib/reasons";
import { CLOSED_STATES } from "../lib/signoff";
import { isConflicted, lockExpense } from "../lib/signoff-facts";
import { requireFinance } from "./approvalService";
import { ServiceError } from "@checkin/component-kit";

/**
 * Approves the expense's tax as it stands; the approval covers that amount only. The note is
 * optional. Refused when the tax does not wait on finance, and for a caller conflicted on the expense.
 */
export async function approveTax(principal: ExpensePrincipal, expenseId: string, note: string | null): Promise<void> {
  requireFinance(principal);
  const actor = actorOf(principal);
  const orgId = await getOrgId();
  await db.$transaction(async (tx) => {
    await lockExpense(tx, expenseId);
    const expense = await tx.expense.findFirst({
      where: { id: expenseId, orgId },
      include: {
        receiptReview: { select: { taxReviewRequired: true, reasons: true, approvedTaxCents: true } },
        taxApproval: { select: { taxCents: true } },
      },
    });
    if (!expense) throw new ServiceError(404, "Expense not found");
    if (CLOSED_STATES.has(expense.state)) throw new ServiceError(400, `Expense is ${expense.state}`);
    if (!taxWaitsOnFinance(expense.taxCents, expense.receiptReview, expense.taxApproval?.taxCents ?? null)) {
      throw new ServiceError(409, "This expense's tax does not wait on finance");
    }
    if (await isConflicted(expense, actor.userId)) {
      throw new ServiceError(403, "You cannot approve tax on an expense that you or your household submitted or would be reimbursed for");
    }
    const approval = { taxCents: expense.taxCents, approvedByUserId: actor.userId, note, approvedAt: new Date() };
    await tx.expenseTaxApproval.upsert({ where: { expenseId }, create: { expenseId, ...approval }, update: approval });
    await writeAudit(tx, actor, { expenseId, action: "tax_approved", fieldChanged: "taxCents", valueAfter: String(expense.taxCents), notes: note });
  });
}
