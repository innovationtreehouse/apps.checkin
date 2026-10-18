// FINANCE marks an expense as test data, which decides whether the QB drain may post it outside prod.
// The host keeps this off outside dev and local; the library does not know the environment.
import { db } from "../db";
import type { ExpensePrincipal } from "../contract";
import { getOrgId } from "../runtime";
import { actorOf } from "../lib/caller";
import { writeAudit } from "../lib/audit";
import { lockExpense } from "../lib/signoff-facts";
import { ServiceError } from "@checkin/component-kit";

const QB_INITIAL = "UNMATCHED";

/** Sets isTestData while the expense has not reached the outbox or QuickBooks; audits every change. */
export async function setTestData(principal: ExpensePrincipal, expenseId: string, isTestData: boolean): Promise<void> {
  if (!principal.isFinance) throw new ServiceError(403, "Only FINANCE marks test data");
  const actor = actorOf(principal);
  const orgId = await getOrgId();

  await db.$transaction(async (tx) => {
    if (!(await tx.expense.findFirst({ where: { id: expenseId, orgId }, select: { id: true } }))) {
      throw new ServiceError(404, "Expense not found");
    }
    await lockExpense(tx, expenseId);
    const current = (await tx.expense.findUnique({
      where: { id: expenseId },
      select: { isTestData: true, qbMatchState: true, lineItems: { where: { qbMatchState: { not: QB_INITIAL } }, select: { id: true }, take: 1 } },
    }))!;
    const outboxed = await tx.expenseEvent.findFirst({ where: { orgId, expenseId }, select: { id: true } });
    if (outboxed || current.qbMatchState !== QB_INITIAL || current.lineItems.length > 0) {
      throw new ServiceError(409, "Test data can only change before the expense is queued for QuickBooks");
    }
    if (current.isTestData === isTestData) return;
    await tx.expense.update({ where: { id: expenseId }, data: { isTestData } });
    await writeAudit(tx, actor, {
      expenseId,
      action: "test_data_set",
      fieldChanged: "isTestData",
      valueBefore: String(current.isTestData),
      valueAfter: String(isTestData),
    });
  });
}
