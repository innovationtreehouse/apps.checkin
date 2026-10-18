/** Scope and paging helpers for the route factories. */
import type { Prisma } from "../generated/prisma/client";
import type { ExpensePrincipal } from "../contract";
import { getExpenseRuntime } from "../runtime";
import { callerId } from "../lib/caller";

/** `page` (1-based) and `limit` (1–200, default 50) as Prisma skip/take. */
export function pageArgs(sp: URLSearchParams): { skip: number; take: number } {
  const page = Math.max(1, Number.parseInt(sp.get("page") ?? "1", 10) || 1);
  const take = Math.min(200, Math.max(1, Number.parseInt(sp.get("limit") ?? "50", 10) || 50));
  return { skip: (page - 1) * take, take };
}

/**
 * Which rows a caller reads: FINANCE and the board read every row; anyone else reads only the
 * lines in buckets they approve, and the expenses containing them. An empty bucket set matches
 * nothing, never "no filter".
 */
export type ViewerScope = { all: true } | { all: false; buckets: number[] };

export async function viewerScope(principal: ExpensePrincipal): Promise<ViewerScope> {
  if (principal.isFinance || principal.isBoard) return { all: true };
  return { all: false, buckets: await getExpenseRuntime().signoff.bucketsApprovedBy(callerId(principal)) };
}

export function scopedExpenses(orgId: string, scope: ViewerScope): Prisma.ExpenseWhereInput {
  return scope.all ? { orgId } : { orgId, approvals: { some: { ownerId: { in: scope.buckets } } } };
}

export function scopedLines(scope: ViewerScope): Prisma.ExpenseLineItemWhereInput {
  return scope.all ? {} : { approvals: { some: { ownerId: { in: scope.buckets } } } };
}

export function scopedApprovals(scope: ViewerScope): Prisma.LineItemOwnerApprovalWhereInput {
  return scope.all ? {} : { ownerId: { in: scope.buckets } };
}
