import { describe, expect, it } from "vitest";
import type { MailboxReader, MailMessage } from "../../contract";
import { mailFiles } from "../../services/mailIntake";

const reader: MailboxReader = { address: "receipts@example.org", listRecent: async () => [], getMessage: async () => { throw new Error("unused"); }, getAttachment: async () => Buffer.alloc(0) };
const b64 = (s: string) => Buffer.from(s).toString("base64url");
const message = (mimeType: string, body: string): MailMessage => ({
  id: "m1",
  internalDate: "0",
  payload: { mimeType: "multipart/alternative", parts: [{ mimeType, body: { data: b64(body), size: body.length } }] },
});
const kept = (mimeType: string, body: string) => mailFiles(message(mimeType, body), reader).files.some((f) => f.body);

describe("mailFiles — the body", () => {
  it("drops an HTML covering note whose only numbers are CSS", () => {
    const note = `<html><head><style>p { line-height: 1.15; margin: 0.25em; }</style></head>
      <body><p style="line-height:1.15;font-size:10.50pt">Receipt for the lathe attached.</p></body></html>`;
    expect(kept("text/html", note)).toBe(false);
  });

  it("keeps an HTML-only receipt with real amounts", () => {
    const receipt = `<html><head><style>td { padding: 0.50em; }</style></head>
      <body><table><tr><td style="width:12.50%">Order total</td><td>$42.17</td></tr></table></body></html>`;
    expect(kept("text/html", receipt)).toBe(true);
  });

  it("reads a plain-text body as it is", () => {
    expect(kept("text/plain", "Order 42 total $5.00")).toBe(true);
    expect(kept("text/plain", "For the lathe, total $5")).toBe(false);
    expect(kept("text/plain", "<p style=\"line-height:1.15\">not html</p>")).toBe(true);
  });
});
