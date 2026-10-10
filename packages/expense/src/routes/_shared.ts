/**
 * Parse, scope and error helpers for the route factories. Failures throw ExpenseHttpError,
 * which the host translates into its own API error, so the library never touches next/server.
 */
import { ZodError, type ZodType } from "zod";
import type { Prisma } from "../generated/prisma/client";
import type { ExpensePrincipal } from "../contract";
import { getExpenseRuntime } from "../runtime";
import { callerId } from "../lib/caller";
import { ServiceError } from "../services/serviceError";

export class ExpenseHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ExpenseHttpError";
  }
}

export const httpError = (status: number, message: string) => new ExpenseHttpError(status, message);

/** Runs a service call, remapping its ServiceError (and a service-side zod parse) to an HTTP error. */
export async function mapServiceErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ServiceError) throw httpError(err.statusCode, err.message);
    if (err instanceof ZodError) throw httpError(400, err.issues[0]?.message ?? "Invalid request");
    throw err;
  }
}

export function parseId(raw: string | undefined, label = "id"): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw httpError(400, `Invalid ${label}`);
  return n;
}

export async function parseBody<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    throw httpError(400, "Invalid JSON body");
  }
  const result = schema.safeParse(json);
  if (!result.success) throw httpError(400, result.error.issues[0]?.message ?? "Invalid request body");
  return result.data;
}

export function query(req: Request): URLSearchParams {
  return new URL(req.url).searchParams;
}

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
