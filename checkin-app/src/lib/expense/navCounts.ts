/**
 * Expense's nav pill counts (#1272): Expense Ops (holds, open flags) and the My Programs
 * "Expense approvals" tab (lines awaiting the viewer's sign-off). Server only.
 */
import { expenseOpsCounts, signoffsAwaitingCount } from "@inventory/expense";
import type { SessionUser } from "@/types/auth";

export async function expenseLibraryCounts(user: SessionUser): Promise<Record<string, number>> {
  if (typeof user.id !== "number") return {};
  const principal = { id: user.id, name: user.name ?? null, isFinance: user.isFinance === true, isBoard: user.isBoardMember === true };
  const [ops, awaitingMySignoff] = await Promise.all([expenseOpsCounts(principal), signoffsAwaitingCount(principal)]);
  return { ...ops, awaitingMySignoff };
}
