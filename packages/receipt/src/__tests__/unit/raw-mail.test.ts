import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { MailMessage, MailPart } from "../../contract";
import { parseRawMail } from "../../lib/rawMail";
import { isAutomated } from "../../services/mailReplies";
import { fromAddress, INLINE_FLOOR_BYTES, mailFiles } from "../../services/mailIntake";
import { toRaw } from "../helpers/mime";

const crlf = (lines: string[]) => Buffer.from(lines.join("\r\n"), "utf8");
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

/** A message from Alice with these MIME lines after its headers. */
const message = (contentType: string, body: string[]) =>
  crlf(["Authentication-Results: mx.google.com; dmarc=pass header.from=example.org", "From: Alice <alice@example.org>", `Content-Type: ${contentType}`, "", ...body]);

const pdfPart = (name: string) => [`Content-Type: application/pdf; name="${name}"`, `Content-Disposition: attachment; filename="${name}"`, "Content-Transfer-Encoding: base64", "", b64(PDF)];

describe("parseRawMail: the headers the sender check reads", () => {
  it("keeps the root headers in order, unfolded, with Google's verdict on top, and the root type", async () => {
    const msg = await parse(crlf([
      "Authentication-Results: mx.google.com;",
      "       dkim=pass header.i=@example.org;",
      "       dmarc=pass header.from=example.org",
      "Authentication-Results: forged.example.net; dmarc=pass",
      "From: Alice <alice@example.org>",
      "Content-Type: multipart/report; report-type=delivery-status; boundary=b",
      "",
      "--b",
      "Content-Type: text/plain",
      "",
      "undeliverable",
      "--b--",
    ]));
    expect(msg.payload.headers?.map((h) => h.name)).toEqual(["Authentication-Results", "Authentication-Results", "From", "Content-Type"]);
    expect(msg.payload.headers?.[0].value).toBe("mx.google.com; dkim=pass header.i=@example.org; dmarc=pass header.from=example.org");
    expect(fromAddress(msg.payload.headers)).toBe("alice@example.org");
    expect(isAutomated(msg.payload, "alice@example.org")).toBe(true);
  });
});

describe("parseRawMail: today's part rules, unchanged", () => {
  it("(a) never opens a forwarded message, attached or inline, and refuses it as forwarded", async () => {
    const forward = ["From: bob@example.org", 'Content-Type: multipart/mixed; boundary="in"', "", "--in", ...pdfPart("inner.pdf"), "--in--"];
    const msg = await parse(message('multipart/mixed; boundary="out"', [
      "--out", "Content-Type: text/plain", "", "see below",
      "--out", "Content-Type: message/rfc822", 'Content-Disposition: attachment; filename="fwd.eml"', "", ...forward,
      "--out", "Content-Type: message/rfc822", "", ...forward,
      "--out--",
    ]));
    const result = await taken(msg);
    expect(result.files).toEqual([]);
    expect(result.refused).toEqual([{ file: "fwd.eml", reason: "forwarded" }, { file: "an attached email", reason: "forwarded" }]);
  });

  it("(b) takes a priced text body, else the HTML as its source, and ignores a short or unpriced one", async () => {
    const plain = await taken(await parse(message("text/plain; charset=utf-8", [`Order total $40.00`, PAD])));
    expect(plain.files).toMatchObject([{ name: "the text of your email", type: "text/plain", body: true }]);

    const html = `<p>Order total $40.00</p><p>${PAD}</p>`;
    const htmlOnly = await parseRawMail("m1", "0", message("text/html", [html]));
    expect(Buffer.from(htmlOnly.payload.parts?.[0].body?.data ?? "", "base64url").toString().trim()).toBe(html);
    expect((await taken(htmlOnly)).files).toMatchObject([{ type: "text/plain", body: true }]);

    expect(await taken(await parse(message("text/plain", ["thanks"])))).toMatchObject({ files: [], ignored: 1, unpriced: null });
    expect((await taken(await parse(message("text/plain", [PAD])))).unpriced).toMatchObject({ body: true });
  });

  it("(c) refuses an unaccepted attached type, and not what a mail client attaches on its own", async () => {
    const msg = await parse(message('multipart/signed; boundary="b"', [
      "--b", 'Content-Type: application/msword; name="r.doc"', 'Content-Disposition: attachment; filename="r.doc"', "", "PK",
      "--b", 'Content-Type: application/pkcs7-signature; name="smime.p7s"', 'Content-Disposition: attachment; filename="smime.p7s"', "", "sig",
      "--b--",
    ]));
    expect((await taken(msg)).refused).toEqual([{ file: "r.doc", reason: "wrong_type" }]);
  });

  it("(d) skips an inline image under the floor and takes one at it", async () => {
    const gif = (n: number) => Buffer.from("GIF89a".padEnd(n, "x"));
    const msg = await parse(message('multipart/related; boundary="b"', [
      "--b", "Content-Type: text/html", "", "<p>photo below</p>",
      "--b", "Content-Type: image/gif", "Content-Disposition: inline", "Content-ID: <logo>", "Content-Transfer-Encoding: base64", "", b64(gif(64)),
      "--b", "Content-Type: image/gif", "Content-Disposition: inline", "Content-ID: <photo>", "Content-Transfer-Encoding: base64", "", b64(gif(INLINE_FLOOR_BYTES)),
      "--b--",
    ]));
    const result = await taken(msg);
    expect(result.files).toMatchObject([{ type: "image/gif", size: INLINE_FLOOR_BYTES }]);
    expect(result.ignored).toBe(2);
  });

  it("(e) keeps a file's decoded name as sent, cut at 200 characters", async () => {
    const long = `${"Квитанция ".repeat(30)}.pdf`;
    const msg = await parse(message('multipart/mixed; boundary="b"', ["--b", ...pdfPart("receipt (1) #2.pdf"), "--b", ...pdfPart(long), "--b--"]));
    expect((await taken(msg)).files.map((f) => f.name)).toEqual(["receipt (1) #2.pdf", long.slice(0, 200)]);
  });
});

describe("parseRawMail: names and nesting", () => {
  it("decodes an RFC 2047 file name", async () => {
    const msg = await parse(message('multipart/mixed; boundary="b"', [
      "--b",
      'Content-Type: application/pdf; name="=?UTF-8?B?UmVjZWlwdCDigJQg?= =?UTF-8?Q?caf=C3=A9.pdf?="',
      "Content-Transfer-Encoding: base64",
      "",
      b64(PDF),
      "--b--",
    ]));
    expect((await taken(msg)).files.map((f) => f.name)).toEqual(["Receipt — café.pdf"]);
  });

  it("decodes an RFC 2231 file name, continued and percent-encoded", async () => {
    const msg = await parse(message('multipart/mixed; boundary="b"', [
      "--b",
      "Content-Type: application/pdf",
      "Content-Disposition: attachment;",
      " filename*0*=utf-8'en'Quittung%20f%C3%BCr%20;",
      ' filename*1="die Drehbank.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      b64(PDF),
      "--b--",
    ]));
    expect((await taken(msg)).files.map((f) => f.name)).toEqual(["Quittung für die Drehbank.pdf"]);
  });

  it("finds the body and the file of a nested multipart, decoding quoted-printable", async () => {
    const msg = await parse(message('multipart/mixed; boundary="outer"', [
      "--outer",
      "Content-Type: multipart/alternative; boundary=inner",
      "",
      "--inner",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      `Total =2440.00 for the caf=C3=A9 =`,
      `order. ${PAD}`,
      "--inner",
      "Content-Type: text/html",
      "",
      "<p>Total $40.00</p>",
      "--inner--",
      "--outer",
      ...pdfPart("r.pdf"),
      "--outer--",
    ]));
    const result = await taken(msg);
    expect(result.files).toEqual([
      { name: "r.pdf", type: "application/pdf", size: PDF.length, bytes: PDF.length, sha: sha(PDF), body: false },
      expect.objectContaining({ body: true }),
    ]);
    expect(Buffer.from(msg.payload.parts?.[0].body?.data ?? "", "base64url").toString().trim()).toBe(`Total $40.00 for the café order. ${PAD}`);
  });
});

/** Messages in Gmail's `format=full` shape, each written out raw and parsed back. */
const FIXTURES: Record<string, MailPart> = {
  "an attached PDF with a covering note": {
    mimeType: "multipart/mixed",
    parts: [
      { mimeType: "text/plain", body: { data: Buffer.from("see attached").toString("base64url") } },
      { mimeType: "application/pdf", filename: "receipt.pdf", body: { data: PDF.toString("base64url") } },
    ],
  },
  "a forwarded message, with a priced body above it": {
    mimeType: "multipart/mixed",
    parts: [
      { mimeType: "text/plain", body: { data: Buffer.from(`fwd total 9.99\n${PAD}`).toString("base64url") } },
      { mimeType: "message/rfc822", filename: "fwd.eml", parts: [{ mimeType: "application/pdf", filename: "inner.pdf", body: { data: PDF.toString("base64url") } }] },
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
};

describe("parseRawMail against the format=full shape", () => {
  it.each(Object.entries(FIXTURES))("takes the same files, types, sizes and hashes from %s", async (_label, payload) => {
    const full: MailMessage = { id: "m1", internalDate: "1700000000000", payload: { ...payload, headers: [{ name: "From", value: "alice@example.org" }] } };
    const fromRaw = await parse(toRaw(full));
    const sized = (p: MailPart): MailPart => ({ ...p, body: p.body && { ...p.body, size: Buffer.from(p.body.data ?? "", "base64url").length }, parts: p.parts?.map(sized) });
    expect(await taken(fromRaw)).toEqual(await taken({ ...full, payload: sized(full.payload) }));
  });
});
