// Gmail intake (#1265 §2a): the last catch-up step of the host's daily cron. Each mailed file
// becomes a receipt by its authenticated sender, or a held mail item for finance.
import { createHash } from "node:crypto";
import { db } from "../db";
import type { MailboxReader, MailMessage, MailPart, ReceiptPrincipal } from "../contract";
import { ACCEPTED_TYPES, checkReceiptFile, MAX_FILE_BYTES } from "../lib/file-type";
import { getOrg, mailbox, ports } from "../runtime";
import { intakeMailedReceipt } from "./receiptService";
import { ServiceError } from "./serviceError";

// ponytail: no stored cursor; the ledger makes re-reads free. Ceiling is a cron outage longer than the window.
export const MAIL_WINDOW_DAYS = 3;
/** New mail items per run; the rest wait for the next run, inside the window. */
export const MAIL_CAP = 10;

export type MailIntakeResult =
  | { status: "unbound" }
  | { status: "ok"; messages: number; receipts: number; held: number; skipped: number; rejected: number; failed: number };

type Headers = { name: string; value: string }[];

const headerValues = (headers: Headers | undefined, name: string): string[] =>
  (headers ?? []).filter((h) => h.name.toLowerCase() === name.toLowerCase()).map((h) => h.value);

const ADDR_SPEC = /^[^\s@<>"(),;:]+@[^\s@<>"(),;:]+\.[^\s@<>"(),;:]+$/;

/** The addr-spec of the message's single `From` header holding a single address, lowercased; else null. */
export function fromAddress(headers: Headers | undefined): string | null {
  const froms = headerValues(headers, "From");
  if (froms.length !== 1) return null;
  const bare = froms[0].replace(/"(?:[^"\\]|\\.)*"/g, "").replace(/\([^()]*\)/g, "");
  // A comma lists two addresses; a colon or semicolon is group syntax.
  if (/[,;:]/.test(bare)) return null;
  const angles = [...bare.matchAll(/<([^<>]*)>/g)];
  const spec = angles.length === 1 ? angles[0][1] : angles.length === 0 && !/[<>]/.test(bare) ? bare : null;
  const trimmed = spec?.trim().toLowerCase();
  return trimmed && ADDR_SPEC.test(trimmed) ? trimmed : null;
}

/**
 * True when Google's own verdict says the `From` domain passed DMARC. Only the topmost
 * `Authentication-Results` header counts, and only when Google wrote it: a sender can write
 * any header below it.
 */
export function dmarcAligned(headers: Headers | undefined, address: string): boolean {
  const topmost = headerValues(headers, "Authentication-Results")[0];
  if (!topmost) return false;
  const [servId, ...results] = topmost.split(";").map((s) => s.trim());
  if (servId.split(/\s+/)[0].toLowerCase() !== "mx.google.com") return false;
  const dmarc = results.find((r) => /^dmarc=/i.test(r));
  if (!dmarc || !/^dmarc=pass\b/i.test(dmarc)) return false;
  return /\bheader\.from=([^\s;]+)/i.exec(dmarc)?.[1].toLowerCase() === address.split("@")[1];
}

/** Every part outside a forwarded message: an attached message's headers and parts are never read. */
function ownParts(part: MailPart): MailPart[] {
  if (part.mimeType.toLowerCase() === "message/rfc822") return [];
  return [part, ...(part.parts ?? []).flatMap(ownParts)];
}

const isAttachment = (p: MailPart) =>
  !!p.filename && !/^\s*inline/i.test(headerValues(p.headers, "Content-Disposition")[0] ?? "");

type MailFile = { declaredType: string; size: number; read: () => Promise<Buffer> };

/** One file per attachment of an accepted type; with none, the body, stored as text. */
export function mailFiles(msg: MailMessage, reader: MailboxReader): MailFile[] {
  const parts = ownParts(msg.payload);
  const read = (p: MailPart) => async () =>
    p.body?.data !== undefined
      ? Buffer.from(p.body.data, "base64url")
      : p.body?.attachmentId
        ? reader.getAttachment(msg.id, p.body.attachmentId)
        : Buffer.alloc(0);
  const attachments = parts.filter((p) => isAttachment(p) && ACCEPTED_TYPES.has(p.mimeType.toLowerCase()));
  if (attachments.length > 0) {
    return attachments.map((p) => ({ declaredType: p.mimeType.toLowerCase(), size: p.body?.size ?? 0, read: read(p) }));
  }
  const bodyPart = (type: string) => parts.find((p) => !isAttachment(p) && p.mimeType.toLowerCase() === type && p.body?.data);
  // HTML is stored as its source text: a receipt file is never served as a page.
  const body = bodyPart("text/plain") ?? bodyPart("text/html");
  return body ? [{ declaredType: "text/plain", size: body.body?.size ?? 0, read: read(body) }] : [];
}

const isUniqueViolation = (err: unknown) =>
  typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";

export async function readMailbox(): Promise<MailIntakeResult> {
  const reader = mailbox();
  if (!reader) return { status: "unbound" };
  const orgId = (await getOrg()).id;
  const counts = { messages: 0, receipts: 0, held: 0, skipped: 0, rejected: 0, failed: 0 };
  const capped = () => counts.receipts + counts.held >= MAIL_CAP;

  async function readMessage(msg: MailMessage, reader: MailboxReader): Promise<void> {
    const headers = msg.payload.headers;
    const address = fromAddress(headers);
    const sender: ReceiptPrincipal | null =
      address && dmarcAligned(headers, address) ? await ports().people.submitterByEmail(address) : null;

    for (const file of mailFiles(msg, reader)) {
      if (capped()) return;
      if (file.size > MAX_FILE_BYTES) {
        counts.rejected++;
        continue;
      }
      const bytes = await file.read();
      const check = checkReceiptFile(bytes, file.declaredType);
      if (!check.ok) {
        counts.rejected++;
        continue;
      }
      const key = { gmailMessageId: msg.id, attachmentHash: createHash("sha256").update(bytes).digest("hex") };
      if (await db.receiptMailItem.findUnique({ where: { gmailMessageId_attachmentHash: key }, select: { id: true } })) {
        counts.skipped++;
        continue;
      }
      const item = { orgId, ...key, receivedAt: new Date(Number(msg.internalDate)), senderAddress: address ?? "" };
      try {
        if (sender) {
          try {
            await intakeMailedReceipt(sender, bytes, check.mimeType, (tx, receiptId) =>
              tx.receiptMailItem.create({ data: { ...item, status: "assigned", receiptId } }),
            );
            counts.receipts++;
            continue;
          } catch (err) {
            // Over the sender's daily upload limit: finance assigns it instead.
            if (!(err instanceof ServiceError && err.statusCode === 429)) throw err;
          }
        }
        await db.receiptMailItem.create({ data: { ...item, status: "held", fileBlob: new Uint8Array(bytes), mimeType: check.mimeType } });
        counts.held++;
      } catch (err) {
        // A concurrent run took this file first.
        if (!isUniqueViolation(err)) throw err;
        counts.skipped++;
      }
    }
  }

  for (const id of await reader.listRecent(MAIL_WINDOW_DAYS)) {
    if (capped()) break;
    counts.messages++;
    try {
      await readMessage(await reader.getMessage(id), reader);
    } catch (err) {
      counts.failed++;
      console.error("[receipt] mail intake failed for one message:", err);
    }
  }
  return { status: "ok", ...counts };
}
