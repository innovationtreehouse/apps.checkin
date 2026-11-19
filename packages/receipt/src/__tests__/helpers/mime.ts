import type { MailMessage, MailPart } from "../../contract";

let boundaries = 0;

/**
 * A `format=full` test message written out as the RFC 822 message Gmail's `format=raw` would hold.
 * `attachments` gives the content of each `body.attachmentId`; a stated `body.size` larger than the
 * content pads it with spaces, so a test can state a file's size and still get a real file of it.
 */
export function toRaw(msg: MailMessage, attachments: Map<string, string> = new Map()): Buffer {
  return Buffer.from(writePart(msg.payload, attachments), "latin1");
}

function partBytes(p: MailPart, attachments: Map<string, string>): Buffer {
  const content = p.body?.data !== undefined
    ? Buffer.from(p.body.data, "base64url")
    : Buffer.from(attachments.get(p.body?.attachmentId ?? "") ?? "");
  const size = p.body?.size ?? 0;
  return size > content.length ? Buffer.concat([content, Buffer.alloc(size - content.length, " ")]) : content;
}

const quoted = (s: string) => `"${s.replace(/["\\]/g, "\\$&")}"`;

function writePart(p: MailPart, attachments: Map<string, string>): string {
  const own = (p.headers ?? []).filter((h) => !/^content-(type|transfer-encoding)$/i.test(h.name));
  const lines = own.map((h) => `${h.name}: ${Buffer.from(h.value, "utf8").toString("latin1")}`);
  const named = p.filename ? `; name=${quoted(p.filename)}` : "";
  if (p.filename && !own.some((h) => /^content-disposition$/i.test(h.name))) lines.push(`Content-Disposition: attachment; filename=${quoted(p.filename)}`);
  if (p.mimeType.toLowerCase() === "message/rfc822") {
    lines.push(`Content-Type: message/rfc822${named}`);
    const inner: MailPart = p.parts ? { mimeType: "multipart/mixed", parts: p.parts } : { mimeType: "text/plain", body: p.body };
    return `${lines.join("\r\n")}\r\n\r\n${writePart(inner, attachments)}`;
  }
  if (p.parts) {
    const boundary = `=_test_${++boundaries}`;
    lines.push(`Content-Type: ${p.mimeType}; boundary=${quoted(boundary)}`);
    const body = p.parts.map((child) => `--${boundary}\r\n${writePart(child, attachments)}\r\n`).join("");
    return `${lines.join("\r\n")}\r\n\r\n${body}--${boundary}--\r\n`;
  }
  lines.push(`Content-Type: ${p.mimeType}${named}`, "Content-Transfer-Encoding: base64");
  const b64 = partBytes(p, attachments).toString("base64").replace(/.{1,76}/g, "$&\r\n");
  return `${lines.join("\r\n")}\r\n\r\n${b64}`;
}
