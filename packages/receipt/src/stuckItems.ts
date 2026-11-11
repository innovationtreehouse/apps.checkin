import type { StuckItem } from "@checkin/component-kit";
import { db } from "./db";
import { pushReceipt, runFullFlow } from "./lib/receipt-flow";
import { DAY_MS } from "./lib/limits";
import { getOrgId } from "./runtime";

const FLOW = "flow";
const PUSH = "push to mapping";

/** Receipts stuck in the flow (`flow_error`) or finalized and not delivered to mapping, timed by their first failure. */
export async function stuckItems(): Promise<StuckItem[]> {
  const rows = await db.receipt.findMany({
    where: {
      orgId: await getOrgId(),
      firstFailedAt: { not: null },
      OR: [{ details: { state: "flow_error" } }, { pushedAt: null, details: { state: "receipt_finalized" } }],
    },
    select: { id: true, firstFailedAt: true, details: { select: { state: true } } },
  });
  return rows.flatMap((r) =>
    r.firstFailedAt ? [{ id: r.id, step: r.details?.state === "flow_error" ? FLOW : PUSH, href: `/receipts/${r.id}`, failedAt: r.firstFailedAt }] : [],
  );
}

/**
 * Runs `step` once for one stuck receipt, and throws when it is still stuck. Safe to repeat: the
 * flow runs only from `uploaded` or `flow_error`, and a push only for a finalized receipt not yet
 * delivered, so a receipt that already moved on is left alone.
 */
export async function retryStuckItem({ id, step }: { id: string; step: string }): Promise<void> {
  if (step !== FLOW && step !== PUSH) throw new Error(`receipt has no step "${step}"`);
  const row = await db.receipt.findFirst({ where: { id, orgId: await getOrgId() }, select: { pushedAt: true, details: { select: { state: true } } } });
  if (!row) throw new Error(`receipt ${id} not found`);
  const state = row.details?.state;
  if (step === FLOW && state === "flow_error") await runFullFlow(id, null).catch(() => undefined);
  if (step === PUSH && state === "receipt_finalized" && !row.pushedAt) await pushReceipt(id, null);
  if ((await stuckItems()).some((item) => item.id === id && item.step === step)) throw new Error(`receipt ${id} is still stuck in ${step}`);
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
