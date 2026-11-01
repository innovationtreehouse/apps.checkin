// Emails telling a receipt's uploader, and the person reimbursed when that is someone else, what
// became of it. Each is owed in the transaction that makes the outcome, sent right after it
// commits, and retried by the daily sweep; the host decides whether a copy reaches anyone.
import { db } from "../db";
import type { OutcomeMail, OutcomeNotice } from "../contract";
import type { Prisma } from "../generated/prisma/client";
import { getOrgId, outcomeMail } from "../runtime";

/** Notices sent per sweep; the rest wait for the next run. */
export const OUTCOME_CAP = 50;
/** Sends that report failure before a notice is given up. */
export const OUTCOME_ATTEMPTS = 3;

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
  const receipt = await db.receipt.findUniqueOrThrow({
    where: { id: row.receiptId },
    select: { uploadedByUserId: true, reimburseePersonId: true, details: { select: { retailer: true, receiptDate: true } } },
  });
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

/** Finish a claimed row, or release it for a later run and count the attempt, giving up after OUTCOME_ATTEMPTS. */
async function settle(id: number, allSent: boolean): Promise<void> {
  if (allSent) {
    await db.receiptOutcomeNotice.update({ where: { id }, data: { doneAt: new Date() } });
    return;
  }
  const { attempts } = await db.receiptOutcomeNotice.update({ where: { id }, data: { claimedAt: null, attempts: { increment: 1 } }, select: { attempts: true } });
  if (attempts >= OUTCOME_ATTEMPTS) await db.receiptOutcomeNotice.update({ where: { id }, data: { doneAt: new Date() } });
}

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
      await settle(id, false).catch((e: unknown) => console.error("[receipt] outcome notice claim not released:", e));
      continue;
    }

    let allSent = true;
    for (const to of copies.owed) {
      let ok = false;
      try {
        ok = await out.send(copies.notice, to);
      } catch (err) {
        console.error(`[receipt] outcome notice to the ${to} failed for receipt ${copies.notice.receiptId}:`, err);
      }
      if (ok) {
        await db.receiptOutcomeNotice.update({ where: { id }, data: { [STAMP[to]]: new Date() } });
        counts.sent++;
      } else {
        allSent = false;
        counts.failed++;
      }
    }
    // ponytail: a crash between a send and its stamp leaves the row claimed and never retried; that is the at-most-once side.
    await settle(id, allSent);
  }
}

/** Best effort, right after the transition commits: sends what the given receipts owe. Never throws; the sweep retries. */
export async function sendOutcomeNotices(receiptIds: string[]): Promise<void> {
  const out = outcomeMail();
  if (!out || receiptIds.length === 0) return;
  try {
    const owed = await db.receiptOutcomeNotice.findMany({
      where: { receiptId: { in: receiptIds }, doneAt: null, claimedAt: null },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    await sendRows(out, owed.map((r) => r.id), { sent: 0, failed: 0 });
  } catch (err) {
    console.error("[receipt] outcome notices not sent; the sweep retries them:", err);
  }
}

/** The daily retry of every notice still owed, oldest first. Does nothing while the host's mail out is unbound. */
export async function sweepOutcomeNotices(): Promise<Counts> {
  const counts = { sent: 0, failed: 0 };
  const out = outcomeMail();
  if (!out) return counts;
  const orgId = await getOrgId();
  const owed = await db.receiptOutcomeNotice.findMany({
    where: { orgId, doneAt: null, claimedAt: null, attempts: { lt: OUTCOME_ATTEMPTS } },
    select: { id: true },
    orderBy: { id: "asc" },
    take: OUTCOME_CAP,
  });
  await sendRows(out, owed.map((r) => r.id), counts);
  return counts;
}
