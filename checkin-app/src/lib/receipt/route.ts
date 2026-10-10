/**
 * Glue between checkin's handler() and the receipt library's services (#1265 §6). The routes
 * gate; the library narrows rows by `Access`, filters a submitter by the principal's id, and
 * throws ServiceError for every expected failure.
 */
import type { Access } from "@inventory/receipt";
import type { Role } from "@/security/core";
import { ApiResponseError, badRequest, unauthorized, type HandlerContext, type HandlerFn } from "@/security/handler";

/**
 * Brand check, not `instanceof`: the instrumentation chunk that configures the library and
 * this route's chunk load separate copies of it, so the class identity differs.
 */
function serviceStatus(err: unknown): number | null {
  if (!(err instanceof Error) || err.name !== "ServiceError") return null;
  const status = "statusCode" in err ? err.statusCode : undefined;
  return typeof status === "number" && Number.isInteger(status) ? status : null;
}

/** Runs a library call, turning its ServiceError into checkin's API error. */
export async function mapServiceErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const status = serviceStatus(err);
    if (status !== null && err instanceof Error) throw new ApiResponseError(status, err.message);
    throw err;
  }
}

export function receiptRoute<P extends Record<string, string>>(fn: HandlerFn<P>): HandlerFn<P> {
  return (ctx) => mapServiceErrors(() => fn(ctx));
}

/** The view handler() picked: FINANCE (or BOARD on a read) acts org-wide, anyone else on their own. */
export function accessOf(role: Role): Access {
  return role === "isFinance" || role === "isBoardMember" ? "finance" : "submitter";
}

export async function readJson(ctx: HandlerContext<Record<string, string>>): Promise<unknown> {
  try {
    return await ctx.req.json();
  } catch {
    throw badRequest("Invalid JSON body");
  }
}

/** The caller's Person.id. Admission already required one; anything else is a 401. */
export function sessionId(ctx: HandlerContext<Record<string, string>>): number {
  if (ctx.auth.type !== "session" || !Number.isInteger(ctx.auth.user.id)) throw unauthorized();
  return ctx.auth.user.id;
}

export function lineItemId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw badRequest("Invalid line item id");
  return id;
}

/**
 * A line row carries no owner column, and the stripper scopes each nested row by itself, so a
 * submitter's lines are stamped with their receipt's uploader or `their_own` strips them.
 */
export function stampLines<T extends object>(lines: T[], uploadedByUserId: number): (T & { uploadedByUserId: number })[] {
  return lines.map((line) => ({ ...line, uploadedByUserId }));
}

/**
 * One line a write returned. A submitter's write reached only their own receipt, so it is
 * stamped with their id; finance reads every line and needs no stamp.
 */
export function ownLine<T extends object>(ctx: HandlerContext<Record<string, string>>, line: T): T {
  return accessOf(ctx.role) === "submitter" ? { ...line, uploadedByUserId: sessionId(ctx) } : line;
}
