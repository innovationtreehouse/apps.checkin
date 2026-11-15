import { db } from "../db";
import { reimburseeUnknown } from "../lib/signoff";
import { unsignedLinesForExpenses } from "../lib/signoff-facts";
import { waitingOnLabel, type ExpenseWaitingOn } from "../lib/waiting-on";

const HOLD_FIELDS = {
  id: true,
  orgId: true,
  state: true,
  submitterId: true,
  reimburseePersonId: true,
  needsReimbursement: true,
  backfill: true,
  receiptTotalCents: true,
  boardAuthorization: true,
  everydayWithinLimits: true,
} as const;

/** Each expense's state label, read for all of them together; a QB Pending one names what holds it. */
export async function waitingOnLabels(rows: readonly { id: string; state: string }[]): Promise<ExpenseWaitingOn[]> {
  const pendingIds = rows.filter((r) => r.state === "qb_pending").map((r) => r.id);
  const pending = pendingIds.length === 0 ? [] : await db.expense.findMany({ where: { id: { in: pendingIds } }, select: HOLD_FIELDS });
  const holds = await unsignedLinesForExpenses(db, pending, { readOnly: true });
  const byId = new Map(pending.map((e) => [e.id, e]));
  return rows.map((r) => {
    const e = byId.get(r.id);
    const lineHolds = [...(holds.get(r.id)?.values() ?? [])].flat();
    return { expenseId: r.id, label: waitingOnLabel(r.state, e ? reimburseeUnknown(e) : false, lineHolds) };
  });
}
