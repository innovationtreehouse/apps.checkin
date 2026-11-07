/** Audit, paging and capped-body helpers for the route factories. */
import type { AuditContext } from "../workflows/disbursement.actor";
import { httpError, isComponentHttpError, zodHttpError } from "@checkin/component-kit";
import type { ZodType } from "zod";
import { getPrincipal } from "../runtime";

/** The largest JSON body the in-kind routes read (64 KB). */
export const MAX_BODY_BYTES = 64 * 1024;

/** Read the body, stopping as soon as it passes `maxBytes`. */
async function readCapped(req: Request, maxBytes: number): Promise<string> {
  if (Number(req.headers.get("content-length")) > maxBytes) throw httpError(413, "Request body too large");
  if (!req.body) return "";
  // ponytail: a body without a web stream (a polyfilled test Request) is read whole, then measured.
  if (typeof req.body.getReader !== "function") {
    const text = await req.text();
    if (Buffer.byteLength(text) > maxBytes) throw httpError(413, "Request body too large");
    return text;
  }
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw httpError(413, "Request body too large");
    }
    chunks.push(value);
  }
  // Buffer.from on the underlying ArrayBuffer accepts chunks from any realm (a test VM included).
  return Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))).toString("utf8");
}

/** component-kit's parseBody, but the body is read with a 64 KB cap. */
export async function parseBodyCapped<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readCapped(req, MAX_BODY_BYTES));
  } catch (err) {
    if (isComponentHttpError(err)) throw err;
    throw httpError(400, "Invalid JSON body");
  }
  const result = schema.safeParse(raw);
  if (!result.success) throw zodHttpError(result.error);
  return result.data;
}

/** A caller's correlation id is kept only when it is a short token; anything else gets a fresh UUID. */
const CORRELATION_ID = /^[A-Za-z0-9._:-]{1,64}$/;

export function correlationId(req: Request): string {
  const supplied = req.headers.get("x-correlation-id");
  return supplied && CORRELATION_ID.test(supplied) ? supplied : crypto.randomUUID();
}

/** Who acts, for workflow audit rows. The id comes only from the host principal. */
export async function auditContext(req: Request): Promise<AuditContext & { actorUserId: number; actorUsername: string }> {
  const principal = await getPrincipal();
  return {
    actorUserId: principal.id,
    actorUsername: principal.name ?? String(principal.id),
    correlationId: correlationId(req),
  };
}

/** `page` (1-based) and `limit` (1–200, default 50) as Prisma skip/take. */
export function pageArgs(req: Request): { skip: number; take: number } {
  const sp = new URL(req.url).searchParams;
  const page = Math.max(1, Number.parseInt(sp.get("page") ?? "1", 10) || 1);
  const take = Math.min(200, Math.max(1, Number.parseInt(sp.get("limit") ?? "50", 10) || 50));
  return { skip: (page - 1) * take, take };
}
