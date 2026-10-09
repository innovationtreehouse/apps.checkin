import { describe, it, expect } from "vitest";
import { checkReceiptFile, MAX_FILE_BYTES } from "../../lib/file-type";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const GIF = Buffer.from("GIF89a....");
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBPVP8 ")]);
const PDF = Buffer.from("%PDF-1.7\n...");

describe("checkReceiptFile", () => {
  it.each([
    ["image/png", PNG],
    ["image/jpeg", JPEG],
    ["image/gif", GIF],
    ["image/webp", WEBP],
    ["application/pdf", PDF],
    ["text/plain", Buffer.from("Acme Hardware\nBolt  $2.00\n")],
  ])("accepts %s whose bytes match", (type, bytes) => {
    expect(checkReceiptFile(bytes, type)).toEqual({ ok: true, mimeType: type });
  });

  it("rejects a renamed file whose bytes are another type", () => {
    expect(checkReceiptFile(PNG, "application/pdf").ok).toBe(false);
  });

  it("rejects a declared image with no matching magic bytes", () => {
    expect(checkReceiptFile(Buffer.from("<html><script>"), "image/png").ok).toBe(false);
  });

  it("rejects text that is not valid UTF-8", () => {
    expect(checkReceiptFile(Buffer.from([0x41, 0xc3, 0x28]), "text/plain").ok).toBe(false);
  });

  it("rejects text holding a NUL byte", () => {
    expect(checkReceiptFile(Buffer.from("abc\u0000def"), "text/plain").ok).toBe(false);
  });

  it("rejects types outside the allowlist (HEIC, HTML)", () => {
    expect(checkReceiptFile(Buffer.from("<html></html>"), "text/html").ok).toBe(false);
    expect(checkReceiptFile(Buffer.from("....ftypheic"), "image/heic").ok).toBe(false);
  });

  it("rejects an empty file and one over the size cap", () => {
    expect(checkReceiptFile(Buffer.alloc(0), "text/plain").ok).toBe(false);
    expect(checkReceiptFile(Buffer.concat([PDF, Buffer.alloc(MAX_FILE_BYTES)]), "application/pdf").ok).toBe(false);
  });
});
