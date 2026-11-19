// A raw RFC 822 message, as Gmail's `format=raw` returns it, read by postal-mime into the shape the
// mail run's sender check and part selection read.
import PostalMime from "postal-mime";
import type { MailMessage, MailPart } from "../contract";

/** postal-mime's nesting limit, so a hostile message cannot recurse without end. */
const MAX_DEPTH = 32;

const bytesOf = (content: ArrayBuffer | Uint8Array | string): Buffer =>
  typeof content === "string" ? Buffer.from(content) : Buffer.from(content instanceof Uint8Array ? content : new Uint8Array(content));

const leaf = (mimeType: string, bytes: Buffer, extra: Partial<MailPart> = {}): MailPart => ({
  mimeType,
  ...extra,
  body: { data: bytes.toString("base64url"), size: bytes.length },
});

/**
 * The message as one part holding its body and its files. The body is postal-mime's text when it has
 * any, else its HTML as source. Every file keeps its decoded name, type and disposition; a message
 * attached whole stays one unopened `message/rfc822` part.
 */
export async function parseRawMail(id: string, internalDate: string, raw: Buffer): Promise<MailMessage> {
  const email = await PostalMime.parse(raw, { forceRfc822Attachments: true, attachmentEncoding: "arraybuffer", maxNestingDepth: MAX_DEPTH });
  const headers = email.headers.map((h) => ({ name: h.originalKey, value: h.value }));
  const rootType = headers.find((h) => h.name.toLowerCase() === "content-type")?.value.split(";")[0].trim().toLowerCase();
  const parts: MailPart[] = [];
  if (email.text?.trim()) parts.push(leaf("text/plain", Buffer.from(email.text)));
  else if (email.html) parts.push(leaf("text/html", Buffer.from(email.html)));
  for (const a of email.attachments) {
    parts.push(leaf(a.mimeType.toLowerCase(), bytesOf(a.content), {
      filename: a.filename ?? "",
      headers: a.disposition ? [{ name: "Content-Disposition", value: a.disposition }] : [],
    }));
  }
  return { id, internalDate, payload: { mimeType: rootType || "text/plain", headers, parts } };
}
