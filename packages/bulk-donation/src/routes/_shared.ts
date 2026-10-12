/**
 * Parse helpers for the route factories. Failures throw a host-rendered HTTP
 * error (runtime.donationError), so the library never touches NextResponse.
 */
import type { ZodType } from "zod";
import type { AuditContext } from "../workflows/disbursement.actor";
import type { DonorReadContext } from "../repositories/audit";
import { donationError, getPrincipal } from "../runtime";

export function parseId(raw: string | undefined, label = "id"): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw donationError(400, `Invalid ${label}`);
  return n;
}

export async function parseBody<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw donationError(400, "Invalid JSON body");
  }
  const result = schema.safeParse(raw);
  if (!result.success) throw donationError(400, result.error.issues[0]?.message ?? "Invalid request body");
  return result.data;
}

function correlationId(req: Request): string {
  return req.headers.get("x-correlation-id") ?? crypto.randomUUID();
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

/** Who reads donor data, through which endpoint (the DONOR_DATA_READ audit row). */
export async function donorReader(req: Request, route: string): Promise<DonorReadContext> {
  return { ...(await auditContext(req)), route };
}
