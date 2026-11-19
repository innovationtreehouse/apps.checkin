// An RFC 822 message, as Gmail's `format=raw` returns it, parsed into the `format=full` shape the
// mail run reads: the part tree, each part's headers, decoded file names, and every body inline.
import type { MailMessage, MailPart } from "../contract";

type Header = { name: string; value: string };

/** Nesting past this is no mail client's; deeper parts are left unread as one opaque body. */
const MAX_DEPTH = 32;

/** Splits header block from body at the first empty line; a message with none is all headers. */
function splitHead(raw: Buffer): { head: Buffer; body: Buffer } {
  if (raw[0] === 0x0a) return { head: Buffer.alloc(0), body: raw.subarray(1) };
  if (raw[0] === 0x0d && raw[1] === 0x0a) return { head: Buffer.alloc(0), body: raw.subarray(2) };
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== 0x0a) continue;
    if (raw[i + 1] === 0x0a) return { head: raw.subarray(0, i), body: raw.subarray(i + 2) };
    if (raw[i + 1] === 0x0d && raw[i + 2] === 0x0a) return { head: raw.subarray(0, i), body: raw.subarray(i + 3) };
  }
  return { head: raw, body: Buffer.alloc(0) };
}

/** Unfolded headers in their order, values trimmed and otherwise as written. */
function parseHeaders(head: Buffer): Header[] {
  const headers: Header[] = [];
  for (const line of head.toString("utf8").replace(/\r?\n(?=[ \t])/g, "").split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    headers.push({ name: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() });
  }
  return headers;
}

const first = (headers: Header[], name: string) => headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;

function decodeCharset(bytes: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset.trim().toLowerCase() || "utf-8").decode(bytes);
  } catch {
    return bytes.toString("latin1");
  }
}

/** RFC 2047 encoded words, adjacent ones joined across the whitespace between them; an unknown charset reads as Latin-1. */
export function decodeWords(value: string): string {
  return value
    .replace(/(=\?[^?\s]+\?[bq]\?[^?\s]*\?=)\s+(?==\?[^?\s]+\?[bq]\?[^?\s]*\?=)/gi, "$1")
    .replace(/=\?([^?\s]+)\?([bq])\?([^?\s]*)\?=/gi, (_word, charset: string, enc: string, text: string) => {
      const bytes = enc.toLowerCase() === "b"
        ? Buffer.from(text, "base64")
        : Buffer.from(text.replace(/_/g, " ").replace(/=([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16))), "latin1");
      // RFC 2231 lets a language follow the charset: `utf-8*en`.
      return decodeCharset(bytes, charset.split("*")[0]);
    });
}

/**
 * A structured header's value and parameters, names lowercased; whitespace counts only inside quotes. RFC 2231 continuations
 * (`name*0`, `name*1*`) are joined in order and their percent-encoded charset text decoded.
 */
export function parseParams(value: string): { value: string; params: Map<string, string> } {
  const tokens: string[] = [];
  let cur = "";
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '"') {
      for (i++; i < value.length && value[i] !== '"'; i++) cur += value[i] === "\\" ? value[++i] ?? "" : value[i];
    } else if (c === ";") {
      tokens.push(cur);
      cur = "";
    } else if (!/\s/.test(c)) cur += c;
  }
  tokens.push(cur);
  const [head, ...rest] = tokens;
  const plain = new Map<string, string>();
  const pieces = new Map<string, { n: number; text: string; encoded: boolean }[]>();
  for (const token of rest) {
    const eq = token.indexOf("=");
    if (eq < 0) continue;
    const key = token.slice(0, eq).toLowerCase();
    const text = token.slice(eq + 1);
    const m = key.match(/^([^*]+)\*(?:(\d+)\*?|)$/);
    if (!m) {
      if (!plain.has(key)) plain.set(key, text);
      continue;
    }
    const list = pieces.get(m[1]) ?? [];
    list.push({ n: m[2] === undefined ? 0 : Number(m[2]), text, encoded: key.endsWith("*") });
    pieces.set(m[1], list);
  }
  const params = new Map(plain);
  for (const [name, list] of pieces) {
    list.sort((a, b) => a.n - b.n);
    let charset = "utf-8";
    const bytes: Buffer[] = [];
    for (const [i, piece] of list.entries()) {
      let text = piece.text;
      if (piece.encoded && i === 0) {
        const parts = text.split("'");
        if (parts.length >= 3) {
          charset = parts[0] || "utf-8";
          text = parts.slice(2).join("'");
        }
      }
      bytes.push(piece.encoded ? Buffer.from(text.replace(/%([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16))), "latin1") : Buffer.from(text, "utf8"));
    }
    params.set(name, decodeCharset(Buffer.concat(bytes), charset));
  }
  return { value: head ?? "", params };
}

function decodeQuotedPrintable(body: Buffer): Buffer {
  const text = body.toString("latin1").replace(/=\r?\n/g, "");
  return Buffer.from(text.replace(/=([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16))), "latin1");
}

function decodeBody(body: Buffer, encoding: string | undefined): Buffer {
  switch (encoding?.trim().toLowerCase()) {
    case "base64":
      return Buffer.from(body.toString("latin1").replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
    case "quoted-printable":
      return decodeQuotedPrintable(body);
    default:
      return body;
  }
}

/** The bodies between `--boundary` lines, without the line break before each delimiter; a missing close ends at the message's end. */
function splitMultipart(body: Buffer, boundary: string): Buffer[] {
  const text = body.toString("latin1");
  const delimiter = `--${boundary}`;
  const parts: Buffer[] = [];
  let start = -1;
  let pos = 0;
  while (pos <= text.length) {
    const at = text.indexOf(delimiter, pos);
    if (at < 0) break;
    const lineStart = at === 0 || text[at - 1] === "\n";
    // A longer boundary that starts with this one is not this one's delimiter.
    const ends = at + delimiter.length >= text.length || /[-\r\n \t]/.test(text[at + delimiter.length]);
    if (!lineStart || !ends) {
      pos = at + delimiter.length;
      continue;
    }
    if (start >= 0) {
      const end = text[at - 2] === "\r" ? at - 2 : at - 1;
      parts.push(body.subarray(start, Math.max(start, end)));
    }
    const close = text.startsWith("--", at + delimiter.length);
    const eol = text.indexOf("\n", at);
    if (close) return parts;
    if (eol < 0) return parts;
    start = eol + 1;
    pos = start;
  }
  if (start >= 0 && start < body.length) parts.push(body.subarray(start));
  return parts;
}

function parsePart(raw: Buffer, depth: number, defaultType = "text/plain"): MailPart {
  const { head, body } = splitHead(raw);
  const headers = parseHeaders(head);
  const type = parseParams(first(headers, "Content-Type") ?? "");
  const mimeType = type.value.includes("/") ? type.value.toLowerCase() : defaultType;
  const disposition = parseParams(first(headers, "Content-Disposition") ?? "");
  const named = disposition.params.get("filename") ?? type.params.get("name");
  const part: MailPart = { mimeType, filename: named ? decodeWords(named) : "", headers };
  const boundary = type.params.get("boundary");
  if (mimeType.startsWith("multipart/") && boundary && depth < MAX_DEPTH) {
    const childType = mimeType === "multipart/digest" ? "message/rfc822" : "text/plain";
    part.parts = splitMultipart(body, boundary).map((p) => parsePart(p, depth + 1, childType));
    part.body = { size: 0 };
    return part;
  }
  const bytes = decodeBody(body, first(headers, "Content-Transfer-Encoding"));
  part.body = { data: bytes.toString("base64url"), size: bytes.length };
  return part;
}

/** Gmail's raw message as its `format=full` message: the same part tree, headers, names, types and bytes. */
export function parseRawMail(id: string, internalDate: string, raw: Buffer): MailMessage {
  return { id, internalDate, payload: parsePart(raw, 0) };
}
