// Account-mapping holds (NO_MATCH / MULTIPLE_MATCHES / NO_PART_NUMBER): FINANCE sets a line's
// account by hand and resubmits.
import { db } from "../db";
import type { ExpensePrincipal } from "../contract";
import { getOrgId } from "../runtime";
import { checkAndProcessExpense } from "../lib/expense-qb-processor";
import { requireFinance } from "./approvalService";
import { ServiceError } from "./serviceError";

export async function setHeldLineAccount(
  principal: ExpensePrincipal,
  expenseId: string,
  lineItemId: number,
  qbAccount: string,
): Promise<void> {
  requireFinance(principal);
  const li = await db.expenseLineItem.findFirst({
    where: { id: lineItemId, expenseId, expense: { orgId: await getOrgId() } },
    select: { id: true },
  });
  if (!li) throw new ServiceError(404, "Line item not found");
  await db.expenseLineItem.update({ where: { id: lineItemId }, data: { manualQbAccount: qbAccount } });
}

export async function resubmitHeldExpense(principal: ExpensePrincipal, expenseId: string): Promise<void> {
  requireFinance(principal);
  const orgId = await getOrgId();
  const expense = await db.expense.findFirst({ where: { id: expenseId, orgId }, select: { id: true } });
  if (!expense) throw new ServiceError(404, "Expense not found");
  await checkAndProcessExpense(orgId, expenseId);
}
