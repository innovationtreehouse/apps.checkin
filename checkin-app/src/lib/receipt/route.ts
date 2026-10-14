/**
 * Glue between checkin's handler() and the receipt library's services (#1265 §6). The routes
 * gate; the library narrows rows by `Access`, filters a submitter by the principal's id, and
 * throws ServiceError for every expected failure.
 */
import type { Access } from "@inventory/receipt";
import { readCapped } from "@inventory/utils";
import { MAX_UPLOAD_BODY_BYTES } from "@/lib/requestBodyLimit";
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

const tooLarge = (message = "Receipt upload is too large") => new ApiResponseError(413, message);

/**
 * The upload's multipart form, read under the API's upload ceiling (a 10 MB file plus framing);
 * the library then holds the file itself to its exact cap.
 */
export async function readUploadForm(req: Request): Promise<FormData> {
  const chunks = await readCapped(req.body, req.headers.get("content-length"), MAX_UPLOAD_BODY_BYTES, () => tooLarge());
  try {
    return await new Response(new Blob(chunks), { headers: { "content-type": req.headers.get("content-type") ?? "" } }).formData();
  } catch {
    throw badRequest("Expected multipart/form-data");
  }
}

/**
 * The bulk import's whole body, base64 rows included, fits the same upload ceiling, so each
 * row's file does too (about 8 MB raw after base64). A batch over it is refused and must be
 * split; a larger receipt goes through the upload route.
 */
export const MAX_IMPORT_BODY_BYTES = MAX_UPLOAD_BODY_BYTES;

/** A capped JSON body: 413 (with `tooLargeMessage`) past the cap, 400 when it is not JSON. */
export async function readJsonCapped(
  body: AsyncIterable<Uint8Array> | null,
  declaredLength: string | null,
  cap: number,
  tooLargeMessage: string,
): Promise<unknown> {
  const chunks = await readCapped(body, declaredLength, cap, () => tooLarge(tooLargeMessage));
  try {
    return JSON.parse(await new Blob(chunks).text());
  } catch {
    throw badRequest("Invalid JSON body");
  }
}
