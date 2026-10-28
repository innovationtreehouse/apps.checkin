// Receipt callee: what happened to each receipt's expense, for its uploader and reimbursee.
import { z } from "zod";
import type { ExpenseOutcomeStatus, ExpenseOutcomes } from "../contract";
import { db } from "../db";
import { getOrgId } from "../runtime";

const idsSchema = z.array(z.string().min(1));

const WITH_FINANCE: ReadonlySet<string> = new Set(["capital_review", "set_depreciation_cycle", "qb_pending", "qb_on_hold", "qb_error"]);

interface OutcomeFacts {
  state: string;
  backfill: boolean;
  needsReimbursement: boolean;
  approvals: { status: string; notes: string | null }[];
  unconfirmedLines: number;
}

export function expenseOutcomeOf(e: OutcomeFacts): { status: ExpenseOutcomeStatus; notes: string[] } {
  if (e.state === "rejected") {
    const notes = e.approvals.filter((a) => a.status === "rejected" && a.notes?.trim()).map((a) => a.notes!.trim());
    return { status: "line_rejected", notes };
  }
  const status: ExpenseOutcomeStatus =
    e.state === "qb_complete"
      ? "complete"
      : e.state === "qb_skipped"
        ? "backfill"
        : e.needsReimbursement && !e.backfill && e.unconfirmedLines > 0
          ? "awaiting_confirmation"
          : e.approvals.some((a) => a.status === "exception_raised")
            ? "exception"
            : WITH_FINANCE.has(e.state)
              ? "with_finance"
              : "awaiting_approval";
  return { status, notes: [] };
}

export const expenseOutcomes: ExpenseOutcomes = {
  async forReceipts(receiptIds) {
    const ids = idsSchema.parse(receiptIds);
    if (ids.length === 0) return new Map();
    const expenses = await db.expense.findMany({
      where: { orgId: await getOrgId(), id: { in: ids } },
      select: {
        id: true,
        state: true,
        backfill: true,
        needsReimbursement: true,
        approvals: { select: { status: true, notes: true }, orderBy: { id: "asc" } },
        _count: { select: { lineItems: { where: { signoffs: { none: { seat: "SUBMITTER" } } } } } },
      },
    });
    return new Map(expenses.map((e) => [e.id, expenseOutcomeOf({ ...e, unconfirmedLines: e._count.lineItems })]));
  },
};
