import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { MailMessage, MailPart } from "../../contract";
import { decodeWords, parseParams, parseRawMail } from "../../lib/rawMail";
import { INLINE_FLOOR_BYTES, mailFiles } from "../../services/mailIntake";
import { toRaw } from "../helpers/mime";

const crlf = (lines: string[]) => Buffer.from(lines.join("\r\n"), "latin1");
const parse = (raw: Buffer) => parseRawMail("m1", "1700000000000", raw);
const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const PDF = Buffer.from("%PDF-1.4 receipt for the lathe, total $41.00");
const PAD = "Thank you for shopping with us. Please keep this email for your records; it is your proof of purchase.";

/** What the mail run takes from a message: each file's name, type, size and hash, and what it ignores or refuses. */
async function taken(msg: MailMessage) {
  const { files, ignored, refused, unpriced } = mailFiles(msg);
  const read = async (f: (typeof files)[number]) => {
    const bytes = await f.read();
    return { name: f.name, type: f.declaredType, size: f.size, bytes: bytes.length, sha: sha(bytes), body: !!f.body };
  };
  return { files: await Promise.all(files.map(read)), ignored, refused, unpriced: unpriced ? await read(unpriced) : null };
}

describe("parseRawMail", () => {
  it("keeps the message's headers in order, unfolded, with Google's verdict on top", () => {
    const msg = parse(crlf([
      "Authentication-Results: mx.google.com;",
      "       dkim=pass header.i=@example.org;",
      "       dmarc=pass header.from=example.org",
      "Authentication-Results: forged.example.net; dmarc=pass",
      "From: Alice <alice@example.org>",
      "Content-Type: text/plain",
      "",
      "hello",
    ]));
    expect(msg).toMatchObject({ id: "m1", internalDate: "1700000000000" });
    expect(msg.payload.headers?.map((h) => h.name)).toEqual(["Authentication-Results", "Authentication-Results", "From", "Content-Type"]);
    expect(msg.payload.headers?.[0].value).toBe("mx.google.com;       dkim=pass header.i=@example.org;       dmarc=pass header.from=example.org");
    expect(Buffer.from(msg.payload.body?.data ?? "", "base64url").toString()).toBe("hello");
  });

  it("reads the part tree, each part's type and decoded bytes, from a mixed message with an alternative body", () => {
    const msg = parse(crlf([
      "From: alice@example.org",
      'Content-Type: multipart/mixed; boundary="outer"',
      "",
      "preamble",
      "--outer",
      "Content-Type: multipart/alternative; boundary=inner",
      "",
      "--inner",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "Total =2440.00 for the caf=C3=A9 =",
      "order",
      "--inner",
      "Content-Type: text/html",
      "",
      "<p>Total $40.00</p>",
      "--inner--",
      "--outer",
      'Content-Type: application/pdf; name="r.pdf"',
      'Content-Disposition: attachment; filename="r.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      b64(PDF),
      "--outer--",
      "epilogue",
    ]));
    const [alt, pdf] = msg.payload.parts ?? [];
    expect(msg.payload.mimeType).toBe("multipart/mixed");
    expect(alt.parts?.map((p) => p.mimeType)).toEqual(["text/plain", "text/html"]);
    expect(Buffer.from(alt.parts?.[0].body?.data ?? "", "base64url").toString()).toBe("Total $40.00 for the café order");
    expect(Buffer.from(alt.parts?.[1].body?.data ?? "", "base64url").toString()).toBe("<p>Total $40.00</p>");
    expect(pdf).toMatchObject({ mimeType: "application/pdf", filename: "r.pdf", body: { size: PDF.length } });
    expect(Buffer.from(pdf.body?.data ?? "", "base64url")).toEqual(PDF);
  });

  it("reads LF-only line endings and a multipart missing its closing delimiter", () => {
    const msg = parse(Buffer.from(["Content-Type: multipart/mixed; boundary=b", "", "--b", "Content-Type: text/plain", "", "one", "--b", "", "two"].join("\n")));
    expect(msg.payload.parts?.map((p) => Buffer.from(p.body?.data ?? "", "base64url").toString())).toEqual(["one", "two"]);
    expect(msg.payload.parts?.[1].mimeType).toBe("text/plain");
  });

  it("decodes an RFC 2047 file name and an RFC 2231 one, continued and percent-encoded", () => {
    const msg = parse(crlf([
      "Content-Type: multipart/mixed; boundary=b",
      "",
      "--b",
      "Content-Type: application/pdf; name=\"=?UTF-8?B?UmVjZWlwdCDigJQg?= =?UTF-8?Q?caf=C3=A9.pdf?=\"",
      "Content-Transfer-Encoding: base64",
      "",
      b64(PDF),
      "--b",
      "Content-Type: application/pdf",
      "Content-Disposition: attachment;",
      " filename*0*=utf-8'en'Quittung%20f%C3%BCr;",
      " filename*1=\" die Drehbank.pdf\"",
      "Content-Transfer-Encoding: base64",
      "",
      b64(PDF),
      "--b--",
    ]));
    expect(msg.payload.parts?.map((p) => p.filename)).toEqual(["Receipt — café.pdf", "Quittung für die Drehbank.pdf"]);
  });

  it("leaves a message attached whole unopened, as one part", () => {
    const msg = parse(crlf([
      "Content-Type: multipart/mixed; boundary=b",
      "",
      "--b",
      "Content-Type: message/rfc822",
      'Content-Disposition: attachment; filename="fwd.eml"',
      "",
      "From: bob@example.org",
      "Content-Type: application/pdf",
      "",
      "%PDF-1.4",
      "--b--",
    ]));
    const [fwd] = msg.payload.parts ?? [];
    expect(fwd).toMatchObject({ mimeType: "message/rfc822", filename: "fwd.eml" });
    expect(fwd.parts).toBeUndefined();
  });

  it("stops nesting at its depth limit, leaving the rest as one opaque body", () => {
    const lines: string[] = [];
    for (let i = 0; i < 40; i++) lines.push(`Content-Type: multipart/mixed; boundary=b${i}`, "", `--b${i}`);
    lines.push("Content-Type: text/plain", "", "deep");
    let depth = 0;
    for (let part: MailPart | undefined = parse(crlf(lines)).payload; part?.parts; part = part.parts[0]) depth++;
    expect(depth).toBe(32);
  });
});

describe("parseParams and decodeWords", () => {
  it("reads quoted values holding a separator, and lowercases names", () => {
    const { value, params } = parseParams('attachment; FileName="a; b.pdf"; size=12');
    expect(value).toBe("attachment");
    expect(Object.fromEntries(params)).toEqual({ filename: "a; b.pdf", size: "12" });
  });

  it("reads an unknown charset as Latin-1 and leaves plain text alone", () => {
    expect(decodeWords("=?x-unknown?Q?caf=E9?=")).toBe("café");
    expect(decodeWords("plain name.pdf")).toBe("plain name.pdf");
  });
});

/** Messages in Gmail's `format=full` shape, each written out raw and parsed back. */
const FIXTURES: Record<string, MailPart> = {
  "an attached PDF with a covering note": {
    mimeType: "multipart/mixed",
    parts: [
      { mimeType: "text/plain", body: { data: Buffer.from("see attached").toString("base64url") } },
      { mimeType: "application/pdf", filename: "receipt.pdf", body: { data: PDF.toString("base64url"), size: PDF.length } },
    ],
  },
  "a forwarded message, with a priced body above it": {
    mimeType: "multipart/mixed",
    parts: [
      { mimeType: "text/plain", body: { data: Buffer.from(`fwd total 9.99\n${PAD}`).toString("base64url") } },
      { mimeType: "message/rfc822", filename: "fwd.eml", parts: [{ mimeType: "application/pdf", filename: "inner.pdf", body: { data: PDF.toString("base64url") } }] },
    ],
  },
  "an inline image under the floor and one over it": {
    mimeType: "multipart/related",
    parts: [
      { mimeType: "text/html", body: { data: Buffer.from("<p>photo below</p>").toString("base64url") } },
      { mimeType: "image/gif", filename: "logo.gif", headers: [{ name: "Content-Disposition", value: "inline" }], body: { data: Buffer.from("GIF89a".padEnd(64, "x")).toString("base64url") } },
      { mimeType: "image/gif", headers: [{ name: "Content-Disposition", value: "inline" }], body: { data: Buffer.from("GIF89a".padEnd(INLINE_FLOOR_BYTES, "x")).toString("base64url") } },
    ],
  },
  "a body-only receipt": {
    mimeType: "multipart/alternative",
    parts: [
      { mimeType: "text/plain", body: { data: Buffer.from(`Order total $40.00\n${PAD}`).toString("base64url") } },
      { mimeType: "text/html", body: { data: Buffer.from(`<p>Order total $40.00</p><p>${PAD}</p>`).toString("base64url") } },
    ],
  },
  "a long body with no amount": { mimeType: "text/plain", body: { data: Buffer.from(PAD).toString("base64url") } },
  "an unaccepted attachment and a client signature": {
    mimeType: "multipart/signed",
    parts: [
      { mimeType: "application/msword", filename: "r.doc", body: { data: Buffer.from("PK").toString("base64url") } },
      { mimeType: "application/pkcs7-signature", filename: "smime.p7s", body: { data: Buffer.from("sig").toString("base64url") } },
    ],
  },
};

describe("parseRawMail against the format=full shape", () => {
  it.each(Object.entries(FIXTURES))("takes the same files, types, sizes and hashes from %s", async (_label, payload) => {
    const full: MailMessage = { id: "m1", internalDate: "1700000000000", payload: { ...payload, headers: [{ name: "From", value: "alice@example.org" }, ...(payload.headers ?? [])] } };
    const fromRaw = parse(toRaw(full));
    // format=full states every part's decoded size; the fixtures leave it to the content.
    const sized = (p: MailPart): MailPart => ({ ...p, body: p.body && { ...p.body, size: Buffer.from(p.body.data ?? "", "base64url").length }, parts: p.parts?.map(sized) });
    expect(await taken(fromRaw)).toEqual(await taken({ ...full, payload: sized(full.payload) }));
  });
});
