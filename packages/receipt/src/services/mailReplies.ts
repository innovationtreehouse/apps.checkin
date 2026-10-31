// Acknowledgements of mailed receipts: one per message, sent once the message has a receipt, to
// its sender and to the person the receipt is credited to when that is someone else, so a person
// whose name someone else mailed a receipt under hears about it. A verified sender is also told
// once which files were refused: on the acknowledgement when it is going out then, else on its own.
import { db } from "../db";
import type { MailAcknowledgement, MailPart, MailRefusal, ReceiptReplies } from "../contract";
import type { Prisma } from "../generated/prisma/client";
import { getOrgId, replies } from "../runtime";

/** Messages acknowledged per run; the rest wait for the next run. */
export const REPLY_CAP = 50;
/** Sends that report failure before a reply is given up. */
export const REPLY_ATTEMPTS = 3;

type Headers = { name: string; value: string }[];

const first = (headers: Headers | undefined, name: string): string | undefined =>
  (headers ?? []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value.trim().toLowerCase();

/**
 * True for mail no person wrote, which is never answered: an auto-reply, a bounce, list or bulk
 * mail, or a message asking not to be auto-answered (RFC 3834 and the common vendor headers).
 */
export function isAutomated(payload: MailPart, address: string | null): boolean {
  const h = payload.headers;
  const autoSubmitted = first(h, "Auto-Submitted");
  if (autoSubmitted !== undefined && autoSubmitted.split(";")[0].trim() !== "no") return true;
  if (["bulk", "junk", "list"].includes(first(h, "Precedence") ?? "")) return true;
  if (["X-Autoreply", "X-Autorespond", "X-Auto-Response-Suppress"].some((n) => first(h, n) !== undefined)) return true;
  if (first(h, "Return-Path")?.replace(/\s/g, "") === "<>") return true;
  if (payload.mimeType.toLowerCase() === "multipart/report") return true;
  return address !== null && /^(mailer-daemon|postmaster)@/.test(address);
}

/**
 * Close the owed reply of each message left with no stored or assigned file, which can no longer
 * become a receipt, so the sweep never scans it again. An unsent refusal notice keeps its row open.
 */
export async function closeUnreplyable(tx: Prisma.TransactionClient | typeof db, gmailMessageIds: string[]): Promise<void> {
  const live = await tx.receiptMailItem.findMany({
    where: { gmailMessageId: { in: gmailMessageIds }, status: { in: ["held", "deferred", "assigned"] } },
    select: { gmailMessageId: true },
  });
  const liveIds = new Set(live.map((l) => l.gmailMessageId));
  const dead = gmailMessageIds.filter((id) => !liveIds.has(id));
  if (dead.length > 0) {
    await tx.receiptMailReply.updateMany({
      where: { gmailMessageId: { in: dead }, doneAt: null, OR: [{ refusals: { equals: [] } }, { refusalSentAt: { not: null } }] },
      data: { doneAt: new Date() },
    });
  }
}

type Send = { fields: ("senderSentAt" | "creditedSentAt" | "refusalSentAt")[]; ack: MailAcknowledgement };

/**
 * The copies still owed on a claimed row. The sender's copy counts as the credited person's only
 * when it is actually sent, so a forged From credited to the person it names still reaches them.
 * Refused files ride on the sender's copy when one is going out, else go alone.
 */
async function owedSends(out: ReceiptReplies, id: number, receiptId: string | null): Promise<Send[]> {
  const row = await db.receiptMailReply.findUniqueOrThrow({ where: { id } });
  const refused = row.refusalSentAt || !row.replyToSender ? [] : (row.refusals as unknown as MailRefusal[]);
  const base = { senderAddress: row.senderAddress, receivedAt: row.receivedAt };
  const notice = refused.length > 0 ? ["refusalSentAt" as const] : [];
  const sends: Send[] = [];

  if (receiptId) {
    // ponytail: a message whose files finance credits to different people acknowledges only the first; add a reply per receipt if that happens.
    const receipt = await db.receipt.findUniqueOrThrow({ where: { id: receiptId }, select: { uploadedByUserId: true } });
    const credited = await out.contactOf(receipt.uploadedByUserId);
    const sameAsSender = row.replyToSender && credited !== null && credited.email.toLowerCase() === row.senderAddress;
    const ack = { ...base, receiptId, refused: [] };
    if (row.replyToSender && !row.senderSentAt) {
      sends.push({
        fields: ["senderSentAt", ...notice],
        ack: { ...ack, refused, to: row.senderAddress, mine: sameAsSender, creditedName: sameAsSender ? credited.name : null },
      });
    }
    if (credited && !sameAsSender && !row.creditedSentAt) {
      sends.push({ fields: ["creditedSentAt"], ack: { ...ack, to: credited.email, mine: true, creditedName: credited.name } });
    }
  }
  if (refused.length > 0 && !sends.some((s) => s.fields.includes("refusalSentAt"))) {
    sends.push({ fields: notice, ack: { ...base, receiptId: null, refused, to: row.senderAddress, mine: false, creditedName: null } });
  }
  return sends;
}

/** Finish a claimed row, or release it for a later run and count the attempt, giving up after REPLY_ATTEMPTS. */
async function settle(id: number, allSent: boolean, hasReceipt: boolean): Promise<void> {
  if (allSent && hasReceipt) {
    await db.receiptMailReply.update({ where: { id }, data: { doneAt: new Date() } });
    return;
  }
  if (allSent) {
    // Only a refusal notice went out: the row stays open for the acknowledgement a stored file may still earn.
    const { gmailMessageId } = await db.receiptMailReply.update({ where: { id }, data: { claimedAt: null }, select: { gmailMessageId: true } });
    await closeUnreplyable(db, [gmailMessageId]);
    return;
  }
  const { attempts } = await db.receiptMailReply.update({ where: { id }, data: { claimedAt: null, attempts: { increment: 1 } }, select: { attempts: true } });
  if (attempts >= REPLY_ATTEMPTS) await db.receiptMailReply.update({ where: { id }, data: { doneAt: new Date() } });
}

/**
 * Send each owed acknowledgement whose message now has a receipt, and each unsent refusal notice. A row is claimed before any
 * send and stays claimed once a send succeeds, so nothing is sent twice; a send that reports
 * failure releases the claim for a later run. Does nothing while the host's mail out is unbound.
 */
export async function sendMailReplies(): Promise<{ sent: number; failed: number }> {
  const out = replies();
  const counts = { sent: 0, failed: 0 };
  if (!out) return counts;
  const orgId = await getOrgId();
  // The first receipt made from each waiting message, by ledger order.
  const owed = await db.$queryRaw<{ id: number; receiptId: string | null }[]>`
    SELECT r.id, (
      SELECT i.receipt_id FROM receipt_mail_items i
      WHERE i.gmail_message_id = r.gmail_message_id AND i.receipt_id IS NOT NULL
      ORDER BY i.id LIMIT 1
    ) AS "receiptId"
    FROM receipt_mail_replies r
    WHERE r.org_id = ${orgId} AND r.done_at IS NULL AND r.claimed_at IS NULL AND r.attempts < ${REPLY_ATTEMPTS}
      AND (
        EXISTS (SELECT 1 FROM receipt_mail_items i WHERE i.gmail_message_id = r.gmail_message_id AND i.receipt_id IS NOT NULL)
        OR (r.reply_to_sender AND r.refusals <> '[]'::jsonb AND r.refusal_sent_at IS NULL)
      )
    ORDER BY r.id
    LIMIT ${REPLY_CAP}`;

  for (const { id, receiptId } of owed) {
    const claimed = await db.receiptMailReply.updateMany({ where: { id, claimedAt: null, doneAt: null }, data: { claimedAt: new Date() } });
    if (claimed.count !== 1) continue;
    let sends: Send[];
    try {
      sends = await owedSends(out, id, receiptId);
    } catch (err) {
      // Nothing was sent, so the claim is released and the attempt counts.
      console.error("[receipt] mail acknowledgement could not be prepared for one message:", err);
      counts.failed++;
      await settle(id, false, receiptId !== null).catch((e: unknown) => console.error("[receipt] mail acknowledgement claim not released:", e));
      continue;
    }

    let allSent = true;
    for (const { fields, ack } of sends) {
      let ok = false;
      try {
        ok = await out.send(ack);
      } catch (err) {
        console.error("[receipt] mail acknowledgement failed for one message:", err);
      }
      if (ok) {
        await db.receiptMailReply.update({ where: { id }, data: Object.fromEntries(fields.map((f) => [f, new Date()])) });
        counts.sent++;
      } else {
        allSent = false;
        counts.failed++;
      }
    }
    // ponytail: a crash between a send and its stamp leaves the row claimed and never retried; that is the at-most-once side.
    await settle(id, allSent, receiptId !== null);
  }
  return counts;
}
