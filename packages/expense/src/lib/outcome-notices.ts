// Emails telling a receipt's uploader, and the person reimbursed when that is someone else, how its
// expense ended. Each is owed in the transition into the final state, sent right after it commits,
// and retried by the daily sweep; the host decides whether a copy reaches anyone.
import { db } from "../db";
import type { OutcomeMail, OutcomeNotice } from "../contract";
import type { Prisma } from "../generated/prisma/client";
import { getExpenseRuntime, getOrgId } from "../runtime";

/** Notices sent per sweep; the rest wait for the next run. */
export const OUTCOME_CAP = 50;
/** Sends that report failure before a notice is given up. */
export const OUTCOME_ATTEMPTS = 3;

type Recipient = "uploader" | "reimbursee";
type Counts = { sent: number; failed: number };
type Tx = Pick<Prisma.TransactionClient, "expense" | "expenseOutcomeNotice">;

const STAMP = { uploader: "uploaderSentAt", reimbursee: "reimburseeSentAt" } as const;

/** The outcome a final state owes an email for; other states owe none. */
const OUTCOME_OF: Record<string, OutcomeNotice["outcome"]> = {
  rejected: "expense_line_rejected",
  qb_complete: "reimbursement_complete",
};

/** Whether entering this state owes an outcome notice. */
export function owesOutcome(state: string): boolean {
  return state in OUTCOME_OF;
}

/**
 * Records the outcome's email as owed, inside the transition's transaction; a replay records
 * nothing more. A card charge's or a backfill's completion is recorded as owing nothing.
 */
export async function oweOutcomeNotice(tx: Tx, expenseId: string, state: string): Promise<void> {
  const outcome = OUTCOME_OF[state];
  if (!outcome) return;
  const expense = await tx.expense.findUniqueOrThrow({ where: { id: expenseId }, select: { orgId: true, needsReimbursement: true, backfill: true } });
  const owesNothing = outcome === "reimbursement_complete" && (!expense.needsReimbursement || expense.backfill);
  await tx.expenseOutcomeNotice.createMany({
    data: [{ orgId: expense.orgId, expenseId, event: outcome, doneAt: owesNothing ? new Date() : null }],
    skipDuplicates: true,
  });
}

/** The notice and the copies still owed on a claimed row. */
async function owedCopies(id: number): Promise<{ notice: OutcomeNotice; owed: Recipient[] }> {
  const row = await db.expenseOutcomeNotice.findUniqueOrThrow({ where: { id } });
  const expense = await db.expense.findUniqueOrThrow({
    where: { id: row.expenseId },
    select: { submitterId: true, reimburseePersonId: true, vendorName: true, receiptDate: true },
  });
  const notice: OutcomeNotice = {
    receiptId: row.expenseId,
    outcome: row.event as OutcomeNotice["outcome"],
    uploaderPersonId: expense.submitterId,
    reimburseePersonId: expense.reimburseePersonId,
    retailer: expense.vendorName,
    receiptDate: expense.receiptDate,
  };
  const owed: Recipient[] = [];
  if (!row.uploaderSentAt) owed.push("uploader");
  const separateReimbursee = expense.reimburseePersonId !== null && expense.reimburseePersonId !== expense.submitterId;
  if (separateReimbursee && !row.reimburseeSentAt) owed.push("reimbursee");
  return { notice, owed };
}

/** Finish a claimed row, or release it for a later run and count the attempt, giving up after OUTCOME_ATTEMPTS. */
async function settle(id: number, allSent: boolean): Promise<void> {
  if (allSent) {
    await db.expenseOutcomeNotice.update({ where: { id }, data: { doneAt: new Date() } });
    return;
  }
  const { attempts } = await db.expenseOutcomeNotice.update({ where: { id }, data: { claimedAt: null, attempts: { increment: 1 } }, select: { attempts: true } });
  if (attempts >= OUTCOME_ATTEMPTS) await db.expenseOutcomeNotice.update({ where: { id }, data: { doneAt: new Date() } });
}

/**
 * Sends each owed copy of the given rows. A row is claimed before any send and stays claimed once
 * a send succeeds, so nothing is sent twice; a send that reports failure releases the claim.
 */
async function sendRows(out: OutcomeMail, ids: number[], counts: Counts): Promise<void> {
  for (const id of ids) {
    const claimed = await db.expenseOutcomeNotice.updateMany({ where: { id, claimedAt: null, doneAt: null }, data: { claimedAt: new Date() } });
    if (claimed.count !== 1) continue;
    let copies: Awaited<ReturnType<typeof owedCopies>>;
    try {
      copies = await owedCopies(id);
    } catch (err) {
      console.error("[expense] outcome notice could not be prepared:", err);
      counts.failed++;
      await settle(id, false).catch((e: unknown) => console.error("[expense] outcome notice claim not released:", e));
      continue;
    }

    let allSent = true;
    for (const to of copies.owed) {
      let ok = false;
      try {
        ok = await out.send(copies.notice, to);
      } catch (err) {
        console.error(`[expense] outcome notice to the ${to} failed for expense ${copies.notice.receiptId}:`, err);
      }
      if (ok) {
        await db.expenseOutcomeNotice.update({ where: { id }, data: { [STAMP[to]]: new Date() } });
        counts.sent++;
      } else {
        allSent = false;
        counts.failed++;
      }
    }
    // A crash between a send and its stamp leaves the row claimed and never retried: at most once, not at least once.
    await settle(id, allSent);
  }
}

/** Best effort, right after the transition commits: sends what the given expenses owe. Never throws; the sweep retries. */
export async function sendOutcomeNotices(expenseIds: string[]): Promise<void> {
  if (expenseIds.length === 0) return;
  try {
    const out = getExpenseRuntime().outcomeMail;
    if (!out) return;
    const owed = await db.expenseOutcomeNotice.findMany({
      where: { expenseId: { in: expenseIds }, doneAt: null, claimedAt: null },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    await sendRows(out, owed.map((r) => r.id), { sent: 0, failed: 0 });
  } catch (err) {
    console.error("[expense] outcome notices not sent; the sweep retries them:", err);
  }
}

/** The daily retry of every notice still owed, oldest first. Does nothing while the host's mail out is unbound. */
export async function sweepOutcomeNotices(): Promise<Counts> {
  const counts = { sent: 0, failed: 0 };
  const out = getExpenseRuntime().outcomeMail;
  if (!out) return counts;
  const orgId = await getOrgId();
  const owed = await db.expenseOutcomeNotice.findMany({
    where: { orgId, doneAt: null, claimedAt: null, attempts: { lt: OUTCOME_ATTEMPTS } },
    select: { id: true },
    orderBy: { id: "asc" },
    take: OUTCOME_CAP,
  });
  await sendRows(out, owed.map((r) => r.id), counts);
  return counts;
}
