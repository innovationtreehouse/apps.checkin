// Counts for the host's receipt flow status page: raw org-wide totals, not a viewer's queue.
import { db } from "../db";
import { STATE_LABELS } from "../lib/expense-constants";
import { getOrgId } from "../runtime";
import { expenseMachine } from "../workflows/expense.machine";

export interface ExpenseStateCount {
  state: string;
  label: string;
  count: number;
}

/** Every state the expense machine defines, in its order. */
export const EXPENSE_STATES: readonly string[] = Object.keys(expenseMachine.config.states ?? {});

/** One count per machine state, zeros included, then any stored state the machine does not define. */
export function tallyExpenseStates(rows: readonly { state: string; _count: { _all: number } }[]): ExpenseStateCount[] {
  const counts = new Map(rows.map((r) => [r.state, r._count._all]));
  const unknown = [...counts.keys()].filter((s) => !EXPENSE_STATES.includes(s));
  return [...EXPENSE_STATES, ...unknown].map((state) => ({ state, label: STATE_LABELS[state] ?? state, count: counts.get(state) ?? 0 }));
}

/** How many of the org's expenses sit in each state. */
export async function expenseStateCounts(): Promise<ExpenseStateCount[]> {
  const rows = await db.expense.groupBy({ by: ["state"], where: { orgId: await getOrgId() }, _count: { _all: true } });
  return tallyExpenseStates(rows);
}
