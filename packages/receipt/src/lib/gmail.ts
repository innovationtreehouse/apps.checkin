import { z } from "zod";
import { MailMessageSchema, type MailboxReader } from "../contract";

// Gmail API host for the receipt mailbox; the poller calls it with a gmail.readonly access token.
export const GMAIL_API_HOST = "gmail.googleapis.com";

const ListSchema = z.object({
  messages: z.array(z.object({ id: z.string().min(1) })).optional(),
  nextPageToken: z.string().optional(),
});
const AttachmentSchema = z.object({ data: z.string() });

/**
 * A read-only reader for one mailbox. Requests name the mailbox as the Gmail user, so a token
 * granted for any other mailbox is refused by Gmail. Errors carry the status only, never a body.
 */
export function createGmailReader(mailboxAddress: string, accessToken: () => Promise<string>): MailboxReader {
  const base = `https://${GMAIL_API_HOST}/gmail/v1/users/${encodeURIComponent(mailboxAddress)}/messages`;

  async function get<T>(url: string, schema: z.ZodType<T>): Promise<T> {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${await accessToken()}` } });
    if (!res.ok) throw new Error(`Gmail request failed: ${res.status}`);
    return schema.parse(await res.json());
  }

  return {
    async listRecent(days) {
      const ids: string[] = [];
      let pageToken: string | undefined;
      do {
        const q = new URLSearchParams({ q: `newer_than:${days}d -in:sent -in:drafts`, maxResults: "500" });
        if (pageToken) q.set("pageToken", pageToken);
        const page = await get(`${base}?${q}`, ListSchema);
        ids.push(...(page.messages ?? []).map((m) => m.id));
        pageToken = page.nextPageToken;
      } while (pageToken);
      // Gmail lists newest first.
      return ids.reverse();
    },
    getMessage: (id) => get(`${base}/${encodeURIComponent(id)}?format=full`, MailMessageSchema),
    async getAttachment(messageId, attachmentId) {
      const { data } = await get(`${base}/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`, AttachmentSchema);
      return Buffer.from(data, "base64url");
    },
  };
}
