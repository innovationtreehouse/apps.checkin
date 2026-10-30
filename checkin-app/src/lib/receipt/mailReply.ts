/**
 * The acknowledgement a mailed receipt gets: to its sender, and to the person it is credited
 * to when that is someone else, who can say "not me" by discarding it and replying. The sender
 * is also told which of the message's files were refused and why.
 */
import type { MailAcknowledgement, MailRefusalReason } from "@checkin/receipt";
import { sendTemplated } from "@/lib/email-templates/send";
import { config } from "@/lib/config";

const REFUSAL_TEXT: Record<MailRefusalReason, string> = {
  too_large: "it is over the 10 MB limit",
  wrong_type: "it is not a PDF, an image (JPEG, PNG, GIF, WebP) or a text file, or its contents do not match its type",
  empty: "the file is empty",
  forwarded: "it is an email attached as a file, which we do not open. Forward the receipt itself instead",
  ceiling: "our receipt queue is full. Please send it again in a few days",
};

/** RFC 3834: marks our mail as automatic, so a well-behaved responder never answers it. */
const AUTO_REPLY_HEADERS = { "Auto-Submitted": "auto-replied" };

const day = (d: Date) => d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

/** Fixed text outside the editable templates, so a Board edit can never drop what was refused. */
function refusedText(ack: MailAcknowledgement): string | undefined {
  if (ack.refused.length === 0) return undefined;
  const lines = ack.refused.map((r) => `${r.file}: ${REFUSAL_TEXT[r.reason]}`);
  return `We could not accept these files from your email of ${day(ack.receivedAt)}:\n${lines.join("\n")}`;
}

/** Sends one acknowledgement or refusal notice. Never mails the receipt mailbox itself, so intake never reads its own reply. */
export async function sendMailReply(ack: MailAcknowledgement, mailboxAddress: string | undefined): Promise<boolean> {
  if (mailboxAddress && ack.to.toLowerCase() === mailboxAddress.toLowerCase()) return true;
  const when = day(ack.receivedAt);
  const refused = refusedText(ack);
  if (ack.receiptId === null) return sendTemplated("receipt.mailRefused", ack.to, { when }, AUTO_REPLY_HEADERS, refused);
  if (!ack.mine) {
    return sendTemplated("receipt.mailReplySender", ack.to, { when, creditedName: ack.creditedName || "a Treehouse member" }, AUTO_REPLY_HEADERS, refused);
  }
  return sendTemplated("receipt.mailReplyCredited", ack.to, {
    creditedName: ack.creditedName ?? "",
    from: ack.to.toLowerCase() === ack.senderAddress ? "you emailed" : `emailed from ${ack.senderAddress}`,
    when,
    actionLink: `${config.baseUrl()}/receipts/${encodeURIComponent(ack.receiptId)}`,
  }, AUTO_REPLY_HEADERS, refused);
}
