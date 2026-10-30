/**
 * The acknowledgement a mailed receipt gets: to its sender, and to the person it is credited
 * to when that is someone else, who can say "not me" by discarding it and replying.
 */
import type { MailAcknowledgement } from "@checkin/receipt";
import { sendTemplated } from "@/lib/email-templates/send";
import { config } from "@/lib/config";

/** RFC 3834: marks our mail as automatic, so a well-behaved responder never answers it. */
const AUTO_REPLY_HEADERS = { "Auto-Submitted": "auto-replied" };

const day = (d: Date) => d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

/** Sends one acknowledgement. Never mails the receipt mailbox itself, so intake never reads its own reply. */
export async function sendMailReply(ack: MailAcknowledgement, mailboxAddress: string | undefined): Promise<boolean> {
  if (mailboxAddress && ack.to.toLowerCase() === mailboxAddress.toLowerCase()) return true;
  const when = day(ack.receivedAt);
  if (!ack.mine) {
    return sendTemplated("receipt.mailReplySender", ack.to, { when, creditedName: ack.creditedName || "a Treehouse member" }, AUTO_REPLY_HEADERS);
  }
  return sendTemplated("receipt.mailReplyCredited", ack.to, {
    creditedName: ack.creditedName ?? "",
    from: ack.to.toLowerCase() === ack.senderAddress ? "you emailed" : `emailed from ${ack.senderAddress}`,
    when,
    actionLink: `${config.baseUrl()}/receipts/${encodeURIComponent(ack.receiptId)}`,
  }, AUTO_REPLY_HEADERS);
}
