import { describe, expect, it } from "vitest";
import type { MailMessage, MailPart } from "../../contract";
import { BODY_MIN_BYTES, bodyText, isRefusalNote, mailFiles, REFUSAL_NOTE_KEY } from "../../services/mailIntake";

const b64 = (s: string) => Buffer.from(s).toString("base64url");
const PDF: MailPart = { mimeType: "application/pdf", filename: "r.pdf", body: { attachmentId: "a", size: 40 } };
const message = (mimeType: string, body: string, extra: MailPart[] = []): MailMessage => ({
  id: "m1",
  internalDate: "0",
  payload: { mimeType: "multipart/mixed", parts: [{ mimeType, body: { data: b64(body), size: body.length } }, ...extra] },
});
const read = (mimeType: string, body: string, extra: MailPart[] = []) => mailFiles(message(mimeType, body, extra));
const kept = (mimeType: string, body: string, extra: MailPart[] = []) => read(mimeType, body, extra).files.some((f) => f.body);
/** Over the size floor on its own, with no amount in it. */
const PAD = "Thank you for shopping with us. Please keep this email for your records; it is your proof of purchase.";

describe("bodyText", () => {
  it("deletes trailer lines and keeps everything below them", () => {
    const text = "FYI\n\nSent from my iPhone\n\n---------- Forwarded message ---------\nOrder total $40.00\n-- \nPat\nSent from Yahoo Mail\nSent from Mail for Windows";
    expect(bodyText(text, false)).toBe("FYI\n---------- Forwarded message ---------\nOrder total $40.00\nPat");
  });

  it("never cuts at a quoted reply", () => {
    expect(bodyText("thanks\nOn Mon, Pat wrote:\n> Total 12.00", false)).toBe("thanks\nOn Mon, Pat wrote:\n> Total 12.00");
  });

  it("keeps a trailer-like line that names an amount", () => {
    expect(bodyText("Sent from my card ending 1234: total $40.00\nSent from my iPhone", false)).toBe("Sent from my card ending 1234: total $40.00");
  });

  it("keeps a line that only starts like a signature separator", () => {
    expect(bodyText("-- total 5.00", false)).toBe("-- total 5.00");
  });
});

describe("mailFiles — the body", () => {
  it("drops an HTML covering note whose only numbers are CSS", () => {
    const note = `<html><head><style>p { line-height: 1.15; margin: 0.25em; }</style></head>
      <body><p style="line-height:1.15;font-size:10.50pt">Receipt for the lathe attached. ${PAD}</p></body></html>`;
    expect(read("text/html", note).unpriced).toBeDefined();
    expect(kept("text/html", note)).toBe(false);
  });

  it("keeps an HTML-only receipt with real amounts", () => {
    const receipt = `<html><head><style>td { padding: 0.50em; }</style></head>
      <body><p>${PAD}</p><table><tr><td style="width:12.50%">Order total</td><td>$42.17</td></tr></table></body></html>`;
    expect(kept("text/html", receipt)).toBe(true);
  });

  it("reads a plain-text body as it is", () => {
    expect(kept("text/plain", `Order 42 total $5.00\n${PAD}`)).toBe(true);
    expect(kept("text/plain", `<p style="line-height:1.15">not html</p>\n${PAD}`)).toBe(true);
  });

  it("takes a dollar amount with no cents", () => {
    expect(kept("text/plain", `For the lathe, total $40\n${PAD}`)).toBe(true);
  });

  it("keeps a forwarded receipt below a phone trailer", () => {
    expect(kept("text/plain", `Sent from my iPhone\n\nBegin forwarded message:\n> ${PAD}\n> Order total 18.25`)).toBe(true);
  });

  it("measures the body without its trailer lines", () => {
    const short = `See you then, total $5\n-- \n${"Sent from my iPhone\n".repeat(10)}`;
    expect(Buffer.byteLength(short)).toBeGreaterThan(BODY_MIN_BYTES);
    expect(read("text/plain", short)).toEqual({ files: [], ignored: 1, refused: [] });
  });

  it("ignores a short body beside an attachment", () => {
    expect(read("text/plain", "see attached", [PDF])).toMatchObject({ files: [expect.objectContaining({ name: "r.pdf" })], ignored: 1 });
  });

  it("reads a long body with an amount beside an attachment", () => {
    expect(kept("text/plain", `Order total 9.00\n${PAD}`, [PDF])).toBe(true);
  });

  it("ignores a long body with no amount beside an attachment", () => {
    const { ignored, unpriced } = read("text/plain", PAD, [PDF]);
    expect([ignored, unpriced]).toEqual([1, undefined]);
  });

  it("ignores a long body with no amount beside a refused attachment", () => {
    const doc: MailPart = { mimeType: "application/msword", filename: "r.doc", body: { attachmentId: "d", size: 40 } };
    expect(read("text/plain", PAD, [doc])).toEqual({ files: [], ignored: 1, refused: [{ file: "r.doc", reason: "wrong_type" }] });
  });

  it("returns a long body with no amount and no attachment as unpriced", () => {
    const { files, ignored, unpriced } = read("text/plain", PAD);
    expect([files, ignored]).toEqual([[], 0]);
    expect(unpriced).toMatchObject({ body: true, declaredType: "text/plain" });
  });

  it("ignores a short body with no attachment", () => {
    expect(read("text/plain", "For the lathe, total $5")).toEqual({ files: [], ignored: 1, refused: [] });
  });
});

describe("isRefusalNote", () => {
  it("is a message's refusal note whatever its status, never a file's row", () => {
    expect(isRefusalNote({ attachmentHash: REFUSAL_NOTE_KEY })).toBe(true);
    expect(isRefusalNote({ attachmentHash: "a".repeat(64) })).toBe(false);
  });
});
