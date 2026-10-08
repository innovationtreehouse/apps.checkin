// The stored type is checked by content, never by the declared Content-Type or extension.
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

const startsWith = (buf: Buffer, sig: number[], at = 0) => sig.every((b, i) => buf[at + i] === b);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

const MAGIC: Record<string, (buf: Buffer) => boolean> = {
  "image/jpeg": (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  "image/png": (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  "image/gif": (b) => startsWith(b, ascii("GIF87a")) || startsWith(b, ascii("GIF89a")),
  "image/webp": (b) => startsWith(b, ascii("RIFF")) && startsWith(b, ascii("WEBP"), 8),
  "application/pdf": (b) => startsWith(b, ascii("%PDF-")),
  "text/plain": (b) => {
    if (b.includes(0)) return false;
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(b);
      return true;
    } catch {
      return false;
    }
  },
};

export type FileCheck = { ok: true; mimeType: string } | { ok: false; error: string };

export function checkReceiptFile(bytes: Buffer, declaredType: string): FileCheck {
  if (bytes.length === 0) return { ok: false, error: "Receipt file is empty" };
  if (bytes.length > MAX_FILE_BYTES) return { ok: false, error: "Receipt file exceeds 10 MB" };
  const matches = MAGIC[declaredType];
  if (!matches) return { ok: false, error: "Unsupported file type" };
  if (!matches(bytes)) return { ok: false, error: "File content does not match its type" };
  return { ok: true, mimeType: declaredType };
}
