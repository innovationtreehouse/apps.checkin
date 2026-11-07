/**
 * The receipt mailbox's live row for the System Status page: whether the Gmail token
 * refresher hands out a token. Read only when the page asks, so it stays off the nav badge.
 * Only a bound mailbox gets the row; the presence row in configHealth.ts covers the rest.
 */
import { kindOf } from "@checkin/component-kit";
import { message, withTimeout, type ConfigCheck } from "@/lib/configHealth";
import { gmailAccessToken } from "@/lib/receipt/gmailToken";
import { receiptMailboxConfig } from "@/lib/receipt/mailboxConfig";

export async function getReceiptMailboxHealth(): Promise<ConfigCheck[]> {
    const mailbox = receiptMailboxConfig();
    if (!mailbox.bound) return [];
    const id = "receipt-mailbox-connection";
    const label = "Receipt mailbox connection";
    try {
        await withTimeout(gmailAccessToken(mailbox)(), "The token refresher");
        return [{ id, label, ok: true, detail: "Connected." }];
    } catch (err) {
        const detail = kindOf(err) === "connection" ? message(err) : `Off: the token refresher failed (${message(err)}).`;
        return [{ id, label, ok: false, detail }];
    }
}
