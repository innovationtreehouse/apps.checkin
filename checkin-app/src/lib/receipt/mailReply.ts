/**
 * The acknowledgement a mailed receipt gets: to its sender, and to the person it is credited
 * to when that is someone else, who can say "not me" by discarding it and replying.
 */
import type { MailAcknowledgement } from "@checkin/receipt";
import { sendEmail } from "@/lib/email";
import { escapeHtml } from "@/lib/email-templates/base";
import { config } from "@/lib/config";

export const MAIL_REPLY_SUBJECT = "Receipt received";

/** RFC 3834: marks our mail as automatic, so a well-behaved responder never answers it. */
const AUTO_REPLY_HEADERS = { "Auto-Submitted": "auto-replied" };

const day = (d: Date) => d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

export function mailReplyHtml(ack: MailAcknowledgement): string {
  const when = escapeHtml(day(ack.receivedAt));
  if (!ack.mine) {
    const whom = ack.creditedName ? escapeHtml(ack.creditedName) : "a Treehouse member";
    return `<p>We received the receipt you emailed on ${when}. It is credited to ${whom}, who reviews it.</p><p>If you did not send this email, reply to this message and tell us.</p>`;
  }
  const link = `${config.baseUrl()}/receipts/${encodeURIComponent(ack.receiptId)}`;
  const from = ack.to.toLowerCase() === ack.senderAddress ? "you emailed" : `emailed from ${escapeHtml(ack.senderAddress)}`;
  return `<p>Hi ${escapeHtml(ack.creditedName ?? "")}, a receipt ${from} on ${when} is now in your receipts, credited to you. <a href="${link}">Review it in My receipts</a>.</p><p>Not yours? Discard it there, and reply to this message to tell us.</p>`;
}

/** Sends one acknowledgement. Never mails the receipt mailbox itself, so intake never reads its own reply. */
export async function sendMailReply(ack: MailAcknowledgement, mailboxAddress: string | undefined): Promise<boolean> {
  if (mailboxAddress && ack.to.toLowerCase() === mailboxAddress.toLowerCase()) return true;
  return sendEmail(ack.to, MAIL_REPLY_SUBJECT, mailReplyHtml(ack), AUTO_REPLY_HEADERS);
}
