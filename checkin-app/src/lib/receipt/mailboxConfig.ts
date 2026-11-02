/**
 * Whether receipt mail intake binds, from env alone. Read by receipt/configure.ts to bind the
 * mailbox and by configHealth.ts to report it, so both answer the same way.
 *
 * Binds only on CHECKIN_ENV prod, dev or stg (exactly), with both values set. An unset or
 * unknown CHECKIN_ENV binds nothing, though checkinEnv() reads it as prod. Off prod (dev, and
 * ops-stg, which reads as prod) it also needs RECEIPT_PROD_MAILBOX_ADDRESS, naming the real
 * mailbox, and refuses that mailbox: a non-prod instance reads only its own test mailbox.
 */
import { config } from "@/lib/config";

export type ReceiptMailboxConfig =
  | { bound: true; functionName: string; mailboxAddress: string }
  /** `refused` names the misconfiguration; null when intake is simply not set up. */
  | { bound: false; refused: string | null };

export function receiptMailboxConfig(): ReceiptMailboxConfig {
  const functionName = process.env.GMAIL_REFRESHER_FN;
  const mailboxAddress = process.env.RECEIPT_MAILBOX_ADDRESS;
  const env = process.env.CHECKIN_ENV;
  if (env === "local" || !functionName || !mailboxAddress) return { bound: false, refused: null };
  if (env !== "prod" && env !== "dev" && env !== "stg") {
    return { bound: false, refused: `CHECKIN_ENV must be prod, dev or stg, not ${JSON.stringify(env ?? "")}` };
  }
  if (env !== "prod" || config.isStaging()) {
    const prodMailbox = process.env.RECEIPT_PROD_MAILBOX_ADDRESS?.trim().toLowerCase();
    if (!prodMailbox || prodMailbox === mailboxAddress.trim().toLowerCase()) {
      return { bound: false, refused: "off prod, RECEIPT_PROD_MAILBOX_ADDRESS must be set and name a different mailbox" };
    }
  }
  return { bound: true, functionName, mailboxAddress };
}
