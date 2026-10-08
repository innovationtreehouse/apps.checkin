import type { Prisma } from "../generated/prisma/client";
import type { Db } from "../db";
import type { NewExpense, NewExpenseLineItem, NewExpenseAuditLog } from "../db/schema";

const EXPENSE_SUMMARY_SELECT = {
  id: true,
  orgId: true,
  submitterId: true,
  vendorName: true,
  currency: true,
  taxCents: true,
  shippingCents: true,
  discountCents: true,
  receiptTotalCents: true,
  receiptDate: true,
  state: true,
  submittedAt: true,
  needsReimbursement: true,
} as const;

export function createExpenseRepository(db: Db) {
  return {
    findExpenseById: (id: string, orgId: string | null) => {
      if (!orgId) return Promise.resolve(null);
      return db.expense.findFirst({ where: { id, orgId } });
    },

    insertExpense: (values: NewExpense) =>
      db.expense.create({ data: values }),

    updateExpense: (id: string, set: Prisma.ExpenseUpdateInput) =>
      db.expense.update({ where: { id }, data: set }),

    listForOrg: (orgId: string) =>
      db.expense.findMany({
        where: { orgId },
        select: EXPENSE_SUMMARY_SELECT,
        orderBy: { submittedAt: "asc" },
      }),

    listExpenseStates: (orgId: string) =>
      db.expense.findMany({
        where: { orgId },
        select: { id: true, state: true },
      }),

    listExpenseIdsByOrgAndState: (orgId: string, state: string) =>
      db.expense.findMany({
        where: { orgId, state },
        select: { id: true },
      }),

    listOwnerApprovalExpenseIds: (orgId: string) =>
      db.expense.findMany({
        where: { orgId, state: "owner_approval" },
        select: { id: true },
      }),

    // ── Line items ────────────────────────────────────────────────────────────

    listLineItems: (expenseId: string) =>
      db.expenseLineItem.findMany({ where: { expenseId } }),

    listLineItemIds: (expenseId: string) =>
      db.expenseLineItem.findMany({
        where: { expenseId },
        select: { id: true },
      }),

    listCapitalLineItemIds: (expenseId: string) =>
      db.expenseLineItem.findMany({
        where: { expenseId, isCapital: true },
        select: { id: true },
      }),

    insertLineItem: (values: NewExpenseLineItem) =>
      db.expenseLineItem.create({ data: values }),

    updateLineItem: (id: number, set: Prisma.ExpenseLineItemUpdateInput, expenseId?: string) =>
      db.expenseLineItem.update({
        where: expenseId ? { id, expenseId } : { id },
        data: set,
      }),

    findLineItemById: (id: number) =>
      db.expenseLineItem.findFirst({ where: { id } }),

    // ── Approvals ─────────────────────────────────────────────────────────────

    listApprovalsByExpenseId: (expenseId: string) =>
      db.lineItemOwnerApproval.findMany({ where: { expenseId } }),

    findApprovalById: (id: number, expenseId: string) =>
      db.lineItemOwnerApproval.findFirst({ where: { id, expenseId } }),

    insertApproval: (values: Prisma.LineItemOwnerApprovalUncheckedCreateInput) =>
      db.lineItemOwnerApproval.create({ data: values }),

    updateApproval: (id: number, set: Prisma.LineItemOwnerApprovalUpdateInput) =>
      db.lineItemOwnerApproval.update({ where: { id }, data: set }),

    updateManyApprovals: (ids: number[], set: Prisma.LineItemOwnerApprovalUpdateInput) =>
      db.lineItemOwnerApproval.updateMany({ where: { id: { in: ids } }, data: set }),

    listUnassignedApprovalExpenseIds: (expenseIds: string[]) =>
      db.lineItemOwnerApproval.findMany({
        where: { expenseId: { in: expenseIds }, ownerId: null },
        select: { expenseId: true },
      }),

    listApprovalExpenseIdsByStatus: (expenseIds: string[], status: string) =>
      db.lineItemOwnerApproval.findMany({
        where: { expenseId: { in: expenseIds }, status },
        select: { expenseId: true },
      }),

    listPendingApprovalsByOwner: (expenseIds: string[], ownerId: number) =>
      db.lineItemOwnerApproval.findMany({
        where: { expenseId: { in: expenseIds }, ownerId, status: "pending" },
        select: { expenseId: true },
      }),

    async listSiblingApprovals(orgId: string, gtin13: string, excludeExpenseId: string) {
      const rows = await db.lineItemOwnerApproval.findMany({
        where: {
          status: "pending",
          ownerId: null,
          expenseId: { not: excludeExpenseId },
          lineItem: { gtin13, expense: { orgId } },
        },
        select: { id: true, expenseId: true, lineItemId: true },
      });
      return rows.map((r) => ({ approvalId: r.id, expenseId: r.expenseId, lineItemId: r.lineItemId }));
    },

    async listSameExpenseUnassignedApprovalsByGtin13(expenseId: string, gtin13: string, excludeApprovalId: number) {
      const rows = await db.lineItemOwnerApproval.findMany({
        where: {
          expenseId,
          ownerId: null,
          id: { not: excludeApprovalId },
          lineItem: { gtin13 },
        },
        select: { id: true, lineItemId: true },
      });
      return rows.map((r) => ({ approvalId: r.id, lineItemId: r.lineItemId }));
    },

    // ── Audit log ─────────────────────────────────────────────────────────────

    insertAuditLog: (values: NewExpenseAuditLog | NewExpenseAuditLog[]) => {
      const arr = Array.isArray(values) ? values : [values];
      return db.expenseAuditLog.createMany({ data: arr });
    },

    // ── Queue helpers ─────────────────────────────────────────────────────────

    listExpenseQueueItems: (ids: string[]) =>
      db.expense.findMany({
        where: { id: { in: ids } },
        select: EXPENSE_SUMMARY_SELECT,
      }),
  };
}

export type ExpenseRepository = ReturnType<typeof createExpenseRepository>;
