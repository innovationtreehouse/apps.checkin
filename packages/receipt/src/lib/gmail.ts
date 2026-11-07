import { KindedError, type FailureKind } from "@checkin/component-kit";
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
 * granted for any other mailbox is refused by Gmail. Errors carry their kind and the status only,
 * never a body; a token-source failure passes through as the source threw it.
 */
export function createGmailReader(mailboxAddress: string, accessToken: () => Promise<string>): MailboxReader {
  const base = `https://${GMAIL_API_HOST}/gmail/v1/users/${encodeURIComponent(mailboxAddress)}/messages`;

  async function get<T>(url: string, schema: z.ZodType<T>): Promise<T> {
    const token = await accessToken();
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } }).catch((err: unknown) => {
      throw new KindedError("system", "Gmail did not answer", { cause: err });
    });
    if (!res.ok) throw new KindedError(gmailStatusKind(res.status), `Gmail request failed: ${res.status}`);
    const body = schema.safeParse(await res.json().catch(() => undefined));
    if (!body.success) throw new KindedError("bug", "Gmail's answer could not be read");
    return body.data;
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

/** 401/403: the mailbox's access is lost; 404: no such mailbox; 429 and 5xx: Gmail is down or busy. */
export function gmailStatusKind(status: number): FailureKind {
  if (status === 401 || status === 403) return "connection";
  if (status === 404) return "settings";
  if (status === 429 || status >= 500) return "system";
  return "bug";
}
