// Which QuickBooks account types expense books to (docs/rules/expenses.md): a capital rule or
// line takes Fixed Asset, every other rule or line an expense type. Saves read QuickBooks live.
import { ServiceError } from "@checkin/component-kit";
import { LINE_ACCOUNT_TYPES, accountTypeRefusal } from "@checkin/quickbooks";
import type { Prisma } from "../generated/prisma/client";
import { getExpenseRuntime } from "../runtime";
import { writeAudit } from "./audit";
import type { Actor } from "./workflow-engine";

/** The types a rule or line books to: Fixed Asset only when it says it's capital. */
export const bookableTypes = (capital: boolean | null): readonly string[] => (capital ? LINE_ACCOUNT_TYPES.donatedCapital : LINE_ACCOUNT_TYPES.donatedGoods);

/** The types expense's QuickBooks account list admits: every type a rule or line may book to. */
export const LISTED_TYPES: readonly string[] = [...LINE_ACCOUNT_TYPES.donatedGoods, ...LINE_ACCOUNT_TYPES.donatedCapital];

/** Refuses (400) an account QuickBooks doesn't list under one of `allowed`; 503 while QuickBooks can't be read. */
export async function refuseWrongType(qbAccount: string, allowed: readonly string[], what: string): Promise<void> {
  const refusal = accountTypeRefusal(await getExpenseRuntime().quickbooks.accounts(), qbAccount, allowed, what);
  if (refusal) throw new ServiceError(400, refusal);
}

/** Drops a line's hand-set account, audited: it was checked against a capital designation that has since changed. */
export async function dropHandSetAccount(
  tx: Prisma.TransactionClient,
  actor: Actor,
  expenseId: string,
  line: { id: number; manualQbAccount: string | null },
  notes?: string,
): Promise<void> {
  if (!line.manualQbAccount) return;
  await tx.expenseLineItem.update({ where: { id: line.id }, data: { manualQbAccount: null } });
  await writeAudit(tx, actor, { expenseId, action: "hold_account_cleared", lineItemId: line.id, fieldChanged: "manualQbAccount", valueBefore: line.manualQbAccount, notes });
}
