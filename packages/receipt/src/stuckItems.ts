import { ServiceError, type StuckItem } from "@checkin/component-kit";
import type { Prisma } from "./generated/prisma/client";
import { db } from "./db";
import { pushReceipt, runFullFlow } from "./lib/receipt-flow";
import { DAY_MS } from "./lib/limits";
import { getOrgId, rawMailRetentionDays } from "./runtime";
import { processCapturedMessage } from "./services/mailIntake";
import { retryOutcomeNotice, STUCK_NOTICE } from "./services/outcomeNotices";
import { stuckSince, stuckUndelivered } from "./repositories/receipt";

const FLOW = "flow";
const PUSH = "push to mapping";
const OUTCOME_EMAIL = "outcome email";
const MAIL_MESSAGE = "mail message";

/** How long a captured email or a queued receipt waits before the Problems list shows it: past one daily run. */
export const WAITING_NOTICE_MS = 25 * 60 * 60_000;

const STUCK_IN = {
  [FLOW]: () => ({ firstFailedAt: { not: null }, details: { state: "flow_error" } }),
  [PUSH]: () => stuckUndelivered(),
} satisfies Record<string, () => Prisma.ReceiptWhereInput>;

/** What a retry that left the receipt stuck answers; the error itself stays on the receipt's page. */
export const STILL_STUCK = "Retried, and it failed again; the receipt's page shows why";

/**
 * Captured emails unprocessed more than WAITING_NOTICE_MS after capture, including those whose stored copy
 * has expired: they stay listed until a person dismisses them.
 */
const stuckMail = (orgId: string, now = Date.now()): Prisma.ReceiptMailMessageWhereInput => ({
  orgId,
  processedAt: null,
  capturedAt: { lt: new Date(now - WAITING_NOTICE_MS) },
});

/** Whether a captured email's stored copy is past retention, by the same rule a replay applies. */
const copyExpired = (capturedAt: Date, now = Date.now()): boolean => now - capturedAt.getTime() >= rawMailRetentionDays() * DAY_MS;

/**
 * Receipts stuck in the flow (`flow_error`) or finalized and not delivered to mapping, timed by
 * `stuckSince`; outcome emails that failed to send, timed by their first failure; and captured
 * emails left unprocessed, timed from capture and marked `expired` once their stored copy is gone.
 */
export async function stuckItems(): Promise<StuckItem[]> {
  const orgId = await getOrgId();
  const steps = [FLOW, PUSH] as const;
  const [since, notices, mail] = await Promise.all([
    Promise.all(steps.map((step) => stuckSince({ orgId, ...STUCK_IN[step]() }))),
    db.receiptOutcomeNotice.findMany({ where: { orgId, ...STUCK_NOTICE }, select: { id: true, receiptId: true, firstFailedAt: true } }),
    db.receiptMailMessage.findMany({ where: stuckMail(orgId), select: { id: true, capturedAt: true }, orderBy: { capturedAt: "asc" } }),
  ]);
  return [
    ...steps.flatMap((step, i) => [...since[i]].map(([id, failedAt]) => ({ id, step, href: `/receipts/${id}`, failedAt }))),
    ...notices.flatMap((n) => (n.firstFailedAt ? [{ id: String(n.id), step: OUTCOME_EMAIL, href: `/receipts/${n.receiptId}`, failedAt: n.firstFailedAt }] : [])),
    ...mail.map((m) => ({ id: String(m.id), step: MAIL_MESSAGE, href: "/receipts/mail", failedAt: m.capturedAt, ...(copyExpired(m.capturedAt) && { expired: true }) })),
  ];
}

/** What a replay from the Problems list that left the email unprocessed answers, with no error text. */
export const MAIL_STILL_STUCK = "Processed again, and it is still not done";

/**
 * Replays one stuck captured email; 404 unless it is listed, 409 when it is still not processed afterwards,
 * carrying the expiry message when its stored copy has expired.
 */
async function retryMail(id: string, by: ProblemRetrier | null): Promise<void> {
  const messageId = Number(id);
  const stuck = Number.isInteger(messageId) && (await db.receiptMailMessage.count({ where: { id: messageId, ...stuckMail(await getOrgId()) } })) > 0;
  if (!stuck) throw new ServiceError(404, "No captured email stuck in this step");
  const outcome = await processCapturedMessage(messageId, by && { id: by.userId, name: by.username }).catch((err: unknown) => {
    // The failure's kind and reason are recorded on the captured email.
    console.error(`[receipt] replaying mail message ${id} failed:`, err);
    return null;
  });
  if (outcome?.status !== "processed") throw new ServiceError(409, outcome?.status === "expired" ? outcome.message : MAIL_STILL_STUCK);
}

async function isStuck(id: string, step: keyof typeof STUCK_IN): Promise<boolean> {
  return (await db.receipt.count({ where: { id, orgId: await getOrgId(), ...STUCK_IN[step]() } })) > 0;
}

/** The person who pressed Retry. */
type ProblemRetrier = { userId: number; username: string | null };

/**
 * Runs `step` once for one stuck item. Safe to repeat: the flow runs only from `uploaded` or
 * `flow_error`, a push only for a finalized receipt not yet delivered, an outcome email only to
 * a recipient not yet sent, and a mail message replay creates only what is missing. An item not
 * stuck in `step` answers 404; one still stuck afterwards answers 409, with no error text.
 */
export async function retryStuckItem({ id, step }: { id: string; step: string }, by: ProblemRetrier | null = null): Promise<void> {
  if (step === OUTCOME_EMAIL) return retryOutcomeNotice(Number(id));
  if (step === MAIL_MESSAGE) return retryMail(id, by);
  if (step !== FLOW && step !== PUSH) throw new ServiceError(404, `No step ${step} in receipt`);
  if (!(await isStuck(id, step))) throw new ServiceError(404, "No receipt stuck in this step");
  // A failure is recorded on the receipt, which the check below reads.
  await (step === FLOW ? runFullFlow(id, null) : pushReceipt(id, null)).catch((err: unknown) => console.error(`[receipt] retrying ${step} for receipt ${id} failed:`, err));
  if (await isStuck(id, step)) throw new ServiceError(409, STILL_STUCK);
}

/** Failed readings within a day that make the Problems list's reading line. */
export const READING_FAILURES_NOTICE_AT = 3;

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/**
 * The Problems list's lines for reading that leaves nothing stuck: readings that failed
 * (`ocr_failed:<kind>`) in the day before `now`, once there are READING_FAILURES_NOTICE_AT of them;
 * and receipts waiting to be read longer than WAITING_NOTICE_MS, which a daily drain has passed by.
 * Counts only, with no error text or names.
 */
export async function problemNotices(now = new Date()): Promise<string[]> {
  const orgId = await getOrgId();
  const [failed, waiting] = await Promise.all([
    db.receiptAuditLog.count({
      where: { action: { startsWith: "ocr_failed:" }, changedAt: { gt: new Date(now.getTime() - DAY_MS) }, receipt: { orgId } },
    }),
    db.receiptDetail.aggregate({
      where: { orgId, state: "ocr_queued", ocrQueuedAt: { lt: new Date(now.getTime() - WAITING_NOTICE_MS) } },
      _count: { _all: true },
      _min: { ocrQueuedAt: true },
    }),
  ]);
  const lines = failed >= READING_FAILURES_NOTICE_AT ? [`Receipt reading failed ${failed} times in the last day`] : [];
  const oldest = waiting._min.ocrQueuedAt;
  if (oldest) {
    const days = Math.floor((now.getTime() - oldest.getTime()) / DAY_MS);
    lines.push(`${plural(waiting._count._all, "receipt")} waiting to be read, the oldest for ${plural(days, "day")}`);
  }
  return lines;
}
