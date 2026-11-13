import { ServiceError, type StuckItem } from "@checkin/component-kit";
import type { Prisma } from "./generated/prisma/client";
import { db } from "./db";
import { pushReceipt, runFullFlow } from "./lib/receipt-flow";
import { DAY_MS } from "./lib/limits";
import { getOrgId } from "./runtime";

const FLOW = "flow";
const PUSH = "push to mapping";

const STUCK_IN = {
  [FLOW]: { details: { state: "flow_error" } },
  [PUSH]: { pushedAt: null, details: { state: "receipt_finalized" } },
} satisfies Record<string, Prisma.ReceiptWhereInput>;

/** What a retry that left the receipt stuck answers; the error itself stays on the receipt's page. */
export const STILL_STUCK = "Retried, and it failed again; the receipt's page shows why";

/** Receipts stuck in the flow (`flow_error`) or finalized and not delivered to mapping, timed by their first failure. */
export async function stuckItems(): Promise<StuckItem[]> {
  const rows = await db.receipt.findMany({
    where: { orgId: await getOrgId(), firstFailedAt: { not: null }, OR: [STUCK_IN[FLOW], STUCK_IN[PUSH]] },
    select: { id: true, firstFailedAt: true, details: { select: { state: true } } },
  });
  return rows.flatMap((r) =>
    r.firstFailedAt ? [{ id: r.id, step: r.details?.state === "flow_error" ? FLOW : PUSH, href: `/receipts/${r.id}`, failedAt: r.firstFailedAt }] : [],
  );
}

async function isStuck(id: string, step: keyof typeof STUCK_IN): Promise<boolean> {
  const where = { id, orgId: await getOrgId(), firstFailedAt: { not: null }, ...STUCK_IN[step] };
  return (await db.receipt.count({ where })) > 0;
}

/**
 * Runs `step` once for one stuck receipt. Safe to repeat: the flow runs only from `uploaded` or
 * `flow_error`, and a push only for a finalized receipt not yet delivered. A receipt not stuck in
 * `step` answers 404; one still stuck afterwards answers 409, with no error text.
 */
export async function retryStuckItem({ id, step }: { id: string; step: string }): Promise<void> {
  if (step !== FLOW && step !== PUSH) throw new ServiceError(404, `No step ${step} in receipt`);
  if (!(await isStuck(id, step))) throw new ServiceError(404, "No receipt stuck in this step");
  // A failure is recorded on the receipt, which the check below reads.
  await (step === FLOW ? runFullFlow(id, null) : pushReceipt(id, null)).catch(() => undefined);
  if (await isStuck(id, step)) throw new ServiceError(409, STILL_STUCK);
}

/** Failed readings within a day that make the Problems list's reading line. */
export const READING_FAILURES_NOTICE_AT = 3;

/**
 * The Problems list's line for automatic reading failing repeatedly, which leaves nothing stuck:
 * readings that failed (`ocr_failed:<kind>`) in the day before `now`, once there are
 * READING_FAILURES_NOTICE_AT of them. A count only, with no error text or names.
 */
export async function problemNotices(now = new Date()): Promise<string[]> {
  const failed = await db.receiptAuditLog.count({
    where: { action: { startsWith: "ocr_failed:" }, changedAt: { gt: new Date(now.getTime() - DAY_MS) }, receipt: { orgId: await getOrgId() } },
  });
  return failed >= READING_FAILURES_NOTICE_AT ? [`Receipt reading failed ${failed} times in the last day`] : [];
}
