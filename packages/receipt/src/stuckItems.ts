import { ServiceError, type StuckItem } from "@checkin/component-kit";
import type { Prisma } from "./generated/prisma/client";
import { db } from "./db";
import { pushReceipt, runFullFlow } from "./lib/receipt-flow";
import { DAY_MS } from "./lib/limits";
import { getOrgId } from "./runtime";
import { stuckSince, stuckUndelivered } from "./repositories/receipt";

const FLOW = "flow";
const PUSH = "push to mapping";

const STUCK_IN = {
  [FLOW]: () => ({ firstFailedAt: { not: null }, details: { state: "flow_error" } }),
  [PUSH]: () => stuckUndelivered(),
} satisfies Record<string, () => Prisma.ReceiptWhereInput>;

/** What a retry that left the receipt stuck answers; the error itself stays on the receipt's page. */
export const STILL_STUCK = "Retried, and it failed again; the receipt's page shows why";

/** Receipts stuck in the flow (`flow_error`) or finalized and not delivered to mapping, timed by `stuckSince`. */
export async function stuckItems(): Promise<StuckItem[]> {
  const orgId = await getOrgId();
  const steps = [FLOW, PUSH] as const;
  const since = await Promise.all(steps.map((step) => stuckSince({ orgId, ...STUCK_IN[step]() })));
  return steps.flatMap((step, i) => [...since[i]].map(([id, failedAt]) => ({ id, step, href: `/receipts/${id}`, failedAt })));
}

async function isStuck(id: string, step: keyof typeof STUCK_IN): Promise<boolean> {
  return (await db.receipt.count({ where: { id, orgId: await getOrgId(), ...STUCK_IN[step]() } })) > 0;
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
  await (step === FLOW ? runFullFlow(id, null) : pushReceipt(id, null)).catch((err: unknown) => console.error(`[receipt] retrying ${step} for receipt ${id} failed:`, err));
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
