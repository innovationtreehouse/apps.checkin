/** Audit and paging helpers for the route factories. */
import type { AuditContext } from "../workflows/disbursement.actor";
import type { DonorReadContext } from "../repositories/audit";
import { getPrincipal } from "../runtime";

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

/** Who reads donor data, through which endpoint (the DONOR_DATA_READ audit row). */
export async function donorReader(req: Request, route: string): Promise<DonorReadContext> {
  return { ...(await auditContext(req)), route };
}

/** `page` (1-based) and `limit` (1–200, default 50) as Prisma skip/take. */
export function pageArgs(req: Request): { skip: number; take: number } {
  const sp = new URL(req.url).searchParams;
  const page = Math.max(1, Number.parseInt(sp.get("page") ?? "1", 10) || 1);
  const take = Math.min(200, Math.max(1, Number.parseInt(sp.get("limit") ?? "50", 10) || 50));
  return { skip: (page - 1) * take, take };
}
