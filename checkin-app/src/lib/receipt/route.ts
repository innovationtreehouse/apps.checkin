/**
 * Glue between checkin's handler() and the receipt library's services (#1265 §6). The routes
 * gate; the library narrows rows by `Access`, filters a submitter by the principal's id, and
 * throws ServiceError for every expected failure.
 */
import type { Access } from "@inventory/receipt";
import type { Role } from "@/security/core";
import { ApiResponseError, badRequest, unauthorized, type HandlerContext, type HandlerFn } from "@/security/handler";
import { checkRateLimit } from "@/lib/rate-limit";

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

/** Room over the file cap for the multipart framing and the `data` field. */
export const FORM_OVERHEAD_BYTES = 512 * 1024;

const tooLarge = () => new ApiResponseError(413, "Receipt upload is too large");

/**
 * Reads a body of at most `cap` bytes. An over-cap declared length is refused before any read;
 * otherwise reading stops (and the stream is cancelled) as soon as the total passes the cap.
 */
export async function readCapped(
  body: AsyncIterable<Uint8Array> | null,
  declaredLength: string | null,
  cap: number,
): Promise<Uint8Array<ArrayBuffer>[]> {
  const declared = Number(declaredLength);
  if (declaredLength !== null && Number.isFinite(declared) && declared > cap) throw tooLarge();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  for await (const value of body ?? []) {
    total += value.byteLength;
    if (total > cap) throw tooLarge();
    chunks.push(new Uint8Array(value));
  }
  return chunks;
}

/** The upload's multipart form, read under the file cap plus the form overhead. */
export async function readUploadForm(req: Request, maxFileBytes: number): Promise<FormData> {
  const chunks = await readCapped(req.body, req.headers.get("content-length"), maxFileBytes + FORM_OVERHEAD_BYTES);
  try {
    return await new Response(new Blob(chunks), { headers: { "content-type": req.headers.get("content-type") ?? "" } }).formData();
  } catch {
    throw badRequest("Expected multipart/form-data");
  }
}

/** Model calls (auto upload and retry) one person may make per day. */
export const OCR_DAILY_LIMIT = 50;

/**
 * Spends one of the caller's daily OCR reads, or answers 429. ponytail: per process, like
 * every limit in lib/rate-limit.ts; the workspace spend cap stays the hard bound.
 */
export function spendOcrQuota(personId: number): void {
  const { ok, retryAfterSec } = checkRateLimit(`receipt-ocr:person:${personId}`, OCR_DAILY_LIMIT, 24 * 60 * 60 * 1000, Date.now());
  if (!ok) {
    throw new ApiResponseError(429, `Daily automatic-reading limit reached; type the details or retry in ${Math.ceil(retryAfterSec / 3600)} h`);
  }
}
