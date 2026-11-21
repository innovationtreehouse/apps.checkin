// Emails telling a receipt's uploader, and the person reimbursed when that is someone else, what
// became of it. Each is owed in the transaction that makes the outcome and sent right after it
// commits; the daily sweep sends any never tried. A failed send leaves the notice stuck on the
// Problems list until a person retries it. The host decides whether a copy reaches anyone.
import { ServiceError } from "@checkin/component-kit";
import { db } from "../db";
import type { OutcomeMail, OutcomeNotice } from "../contract";
import type { Prisma } from "../generated/prisma/client";
import { withLivePeople } from "../lib/livePeople";
import { getOrgId, outcomeMail } from "../runtime";

/** Notices sent per sweep; the rest wait for the next run. */
export const OUTCOME_CAP = 50;
/** What a Retry answers when the email failed to send again. */
export const SEND_FAILED_AGAIN = "Retried, and the email failed to send again";

const NEVER_TRIED = { doneAt: null, claimedAt: null, firstFailedAt: null };
/** A notice whose send failed and waits for a person's Retry. */
export const STUCK_NOTICE = { doneAt: null, claimedAt: null, firstFailedAt: { not: null } };

type Recipient = "uploader" | "reimbursee";
type Counts = { sent: number; failed: number };

const STAMP = { uploader: "uploaderSentAt", reimbursee: "reimburseeSentAt" } as const;

/** Records the outcome's email as owed, inside the transition's transaction; a replay records nothing more. */
export async function oweOutcomeNotice(tx: Prisma.TransactionClient, orgId: string, receiptId: string, outcome: OutcomeNotice["outcome"]): Promise<void> {
  await tx.receiptOutcomeNotice.createMany({ data: [{ orgId, receiptId, event: outcome }], skipDuplicates: true });
}

/** The notice and the copies still owed on a claimed row. */
async function owedCopies(id: number): Promise<{ notice: OutcomeNotice; owed: Recipient[] }> {
  const row = await db.receiptOutcomeNotice.findUniqueOrThrow({ where: { id } });
  const [receipt] = await withLivePeople([
    await db.receipt.findUniqueOrThrow({
      where: { id: row.receiptId },
      select: { uploadedByUserId: true, reimburseePersonId: true, details: { select: { retailer: true, receiptDate: true } } },
    }),
  ]);
  const notice: OutcomeNotice = {
    receiptId: row.receiptId,
    outcome: row.event as OutcomeNotice["outcome"],
    uploaderPersonId: receipt.uploadedByUserId,
    reimburseePersonId: receipt.reimburseePersonId,
    retailer: receipt.details?.retailer ?? null,
    receiptDate: receipt.details?.receiptDate ?? null,
  };
  const owed: Recipient[] = [];
  if (!row.uploaderSentAt) owed.push("uploader");
  const separateReimbursee = receipt.reimburseePersonId !== null && receipt.reimburseePersonId !== receipt.uploadedByUserId;
  if (separateReimbursee && !row.reimburseeSentAt) owed.push("reimbursee");
  return { notice, owed };
}

/** Finish a claimed row, or release it stuck with the failure's text, timed by its first failure. */
async function settle(id: number, failure: string | null): Promise<void> {
  if (failure === null) {
    await db.receiptOutcomeNotice.update({ where: { id }, data: { doneAt: new Date() } });
    return;
  }
  await db.receiptOutcomeNotice.updateMany({ where: { id, firstFailedAt: null }, data: { firstFailedAt: new Date() } });
  await db.receiptOutcomeNotice.update({ where: { id }, data: { claimedAt: null, failureReason: failure } });
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Sends each owed copy of the given rows. A row is claimed before any send and stays claimed once
 * a send succeeds, so nothing is sent twice; a send that reports failure releases the claim.
 */
async function sendRows(out: OutcomeMail, ids: number[], counts: Counts): Promise<void> {
  for (const id of ids) {
    const claimed = await db.receiptOutcomeNotice.updateMany({ where: { id, claimedAt: null, doneAt: null }, data: { claimedAt: new Date() } });
    if (claimed.count !== 1) continue;
    let copies: Awaited<ReturnType<typeof owedCopies>>;
    try {
      copies = await owedCopies(id);
    } catch (err) {
      console.error("[receipt] outcome notice could not be prepared:", err);
      counts.failed++;
      await settle(id, `Not prepared: ${errorText(err)}`).catch((e: unknown) => console.error("[receipt] outcome notice claim not released:", e));
      continue;
    }

    const failures: string[] = [];
    for (const to of copies.owed) {
      let ok = false;
      let why = "the mail out reported failure";
      try {
        ok = await out.send(copies.notice, to);
      } catch (err) {
        why = errorText(err);
        console.error(`[receipt] outcome notice to the ${to} failed for receipt ${copies.notice.receiptId}:`, err);
      }
      if (ok) {
        await db.receiptOutcomeNotice.update({ where: { id }, data: { [STAMP[to]]: new Date() } });
        counts.sent++;
      } else {
        failures.push(`To the ${to}: ${why}`);
        counts.failed++;
      }
    }
    // ponytail: a crash between a send and its stamp leaves the row claimed and never retried; that is the at-most-once side.
    await settle(id, failures.length > 0 ? failures.join("; ") : null);
  }
}

/** Best effort, right after the transition commits: sends what the given receipts owe. Never throws; a failure is left stuck. */
export async function sendOutcomeNotices(receiptIds: string[]): Promise<void> {
  const out = outcomeMail();
  if (!out || receiptIds.length === 0) return;
  try {
    const owed = await db.receiptOutcomeNotice.findMany({
      where: { receiptId: { in: receiptIds }, ...NEVER_TRIED },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    await sendRows(out, owed.map((r) => r.id), { sent: 0, failed: 0 });
  } catch (err) {
    console.error("[receipt] outcome notices not sent; the sweep sends those never tried:", err);
  }
}

/** The daily send of every notice owed and never tried, oldest first. Does nothing while the host's mail out is unbound. */
export async function sweepOutcomeNotices(): Promise<Counts> {
  const counts = { sent: 0, failed: 0 };
  const out = outcomeMail();
  if (!out) return counts;
  const orgId = await getOrgId();
  const owed = await db.receiptOutcomeNotice.findMany({
    where: { orgId, ...NEVER_TRIED },
    select: { id: true },
    orderBy: { id: "asc" },
    take: OUTCOME_CAP,
  });
  await sendRows(out, owed.map((r) => r.id), counts);
  return counts;
}

/**
 * Sends one stuck notice's owed copies once, for a person's Retry. One not stuck answers 404, an
 * unbound mail out 503, and a send that fails again 409, leaving the notice stuck.
 */
export async function retryOutcomeNotice(id: number): Promise<void> {
  const orgId = await getOrgId();
  if (!Number.isSafeInteger(id) || !(await db.receiptOutcomeNotice.findFirst({ where: { id, orgId, ...STUCK_NOTICE }, select: { id: true } }))) throw new ServiceError(404, "No stuck outcome email with this id");
  const out = outcomeMail();
  if (!out) throw new ServiceError(503, "Outcome emails are not set up");
  await sendRows(out, [id], { sent: 0, failed: 0 });
  const { doneAt } = await db.receiptOutcomeNotice.findUniqueOrThrow({ where: { id }, select: { doneAt: true } });
  if (!doneAt) throw new ServiceError(409, SEND_FAILED_AGAIN);
}
