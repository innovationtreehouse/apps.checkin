// Account-mapping holds (NO_MATCH / MULTIPLE_MATCHES / NO_PART_NUMBER): FINANCE sets a line's
// account by hand and resubmits. The same resubmit retries a failed QuickBooks post.
import { db } from "../db";
import type { ExpensePrincipal } from "../contract";
import { getOrgId } from "../runtime";
import { checkAndProcessExpense, retryQbPost } from "../lib/expense-qb-processor";
import { POSTING } from "../lib/expense-qb-poster";
import { lockExpense } from "../lib/signoff-facts";
import { writeAudit } from "../lib/audit";
import { actorOf } from "../lib/caller";
import { requireFinance } from "./approvalService";
import { ServiceError } from "@checkin/component-kit";

/** Once the entry is (or is being) booked, a line's account is corrected in QuickBooks, not here. */
const IN_QUICKBOOKS = new Set([POSTING, "CREATED", "MATCHED"]);

export async function setHeldLineAccount(
  principal: ExpensePrincipal,
  expenseId: string,
  lineItemId: number,
  qbAccount: string,
): Promise<void> {
  requireFinance(principal);
  const li = await db.expenseLineItem.findFirst({
    where: { id: lineItemId, expenseId, expense: { orgId: await getOrgId() } },
    select: { id: true, manualQbAccount: true },
  });
  if (!li) throw new ServiceError(404, "Line item not found");
  await db.$transaction(async (tx) => {
    await lockExpense(tx, expenseId);
    const { qbMatchState } = await tx.expense.findUniqueOrThrow({ where: { id: expenseId }, select: { qbMatchState: true } });
    if (IN_QUICKBOOKS.has(qbMatchState)) throw new ServiceError(409, "already posted to QuickBooks; correct it there");
    await tx.expenseLineItem.update({ where: { id: lineItemId }, data: { manualQbAccount: qbAccount } });
    await writeAudit(tx, actorOf(principal), {
      expenseId,
      action: "hold_account_set",
      lineItemId,
      fieldChanged: "manualQbAccount",
      valueBefore: li.manualQbAccount,
      valueAfter: qbAccount,
    });
  });
}

export async function resubmitHeldExpense(principal: ExpensePrincipal, expenseId: string): Promise<void> {
  requireFinance(principal);
  const orgId = await getOrgId();
  const expense = await db.expense.findFirst({ where: { id: expenseId, orgId }, select: { id: true, qbMatchState: true } });
  if (!expense) throw new ServiceError(404, "Expense not found");
  // Processing runs as the system actor across its own transactions; the audit row records who asked.
  if (expense.qbMatchState === "POST_FAILED" || expense.qbMatchState === "NEEDS_FINANCE") {
    if (!(await retryQbPost(orgId, expenseId, actorOf(principal)))) {
      throw new ServiceError(409, "A line no longer resolves to one QuickBooks account; fix the account mapping first");
    }
    return;
  }
  await writeAudit(db, actorOf(principal), { expenseId, action: "hold_resubmitted" });
  await checkAndProcessExpense(orgId, expenseId);
}
