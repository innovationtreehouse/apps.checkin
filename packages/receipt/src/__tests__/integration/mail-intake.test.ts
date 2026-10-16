import { beforeEach, expect, it } from "vitest";
import { db } from "../../db";
import type { MailboxReader, MailMessage, MailPart } from "../../contract";
import { MAIL_CAP, readMailbox } from "../../services/mailIntake";
import { describeDb } from "../helpers/db";
import { ALICE, clearAll, configure, okOcr, stateOf } from "../helpers/setup";

const GOOGLE_PASS = "mx.google.com; dkim=pass header.i=@example.org; spf=pass; dmarc=pass (p=NONE sp=NONE) header.from=example.org";
const b64 = (s: string) => Buffer.from(s).toString("base64url");
const pdf = (label: string) => `%PDF-1.4 receipt ${label}`;

/** A fake Gmail mailbox: messages by id, attachments by id. */
function fakeMailbox() {
  const messages = new Map<string, MailMessage>();
  const attachments = new Map<string, string>();
  const reader: MailboxReader = {
    listRecent: async () => [...messages.keys()],
    getMessage: async (id) => messages.get(id) ?? Promise.reject(new Error(`no message ${id}`)),
    getAttachment: async (_messageId, attachmentId) => Buffer.from(attachments.get(attachmentId) ?? ""),
  };
  return { messages, attachments, reader };
}

let mail: ReturnType<typeof fakeMailbox>;

const attachment = (id: string, content: string, over: Partial<MailPart> = {}): MailPart => {
  mail.attachments.set(id, content);
  return { mimeType: "application/pdf", filename: `${id}.pdf`, body: { attachmentId: id, size: content.length }, ...over };
};

/** A message; `auth` lists its Authentication-Results headers top first, `from` its From headers. */
function send(
  id: string,
  { from = ["Alice <alice@example.org>"], auth = [GOOGLE_PASS], parts }: { from?: string[]; auth?: string[]; parts?: MailPart[] } = {},
): void {
  mail.messages.set(id, {
    id,
    internalDate: String(Date.now()),
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        ...auth.map((value) => ({ name: "Authentication-Results", value })),
        ...from.map((value) => ({ name: "From", value })),
      ],
      parts: parts ?? [{ mimeType: "text/plain", body: { data: b64("see attached") } }, attachment(`att-${id}`, pdf(id))],
    },
  });
}

beforeEach(async () => {
  await clearAll();
  mail = fakeMailbox();
  configure({
    ocr: okOcr(),
    mailbox: mail.reader,
    people: { submitterByEmail: async (address) => (address === "alice@example.org" ? ALICE : null) },
  });
});

describeDb("mail intake", () => {
  it("turns a new message from a known sender into one receipt by that sender", async () => {
    send("m1");
    expect(await readMailbox()).toMatchObject({ status: "ok", receipts: 1, held: 0 });

    const [receipt] = await db.receipt.findMany();
    expect(receipt).toMatchObject({ intakeSource: "email", uploadedByUserId: ALICE.id, mimeType: "application/pdf" });
    expect(Buffer.from(receipt.fileBlob).toString()).toBe(pdf("m1"));
    expect(await stateOf(receipt.id)).toBe("submitter_review");
    const [item] = await db.receiptMailItem.findMany();
    expect(item).toMatchObject({ status: "assigned", receiptId: receipt.id, senderAddress: "alice@example.org", fileBlob: null });
  });

  it("creates nothing on a re-read", async () => {
    send("m1");
    await readMailbox();
    expect(await readMailbox()).toMatchObject({ receipts: 0, held: 0, skipped: 1 });
    expect(await db.receipt.count()).toBe(1);
    expect(await db.receiptMailItem.count()).toBe(1);
  });

  it("holds a message from an unknown sender for finance, with its file", async () => {
    send("m1", { from: ["stranger@example.org"] });
    expect(await readMailbox()).toMatchObject({ receipts: 0, held: 1 });
    expect(await db.receipt.count()).toBe(0);
    const [item] = await db.receiptMailItem.findMany();
    expect(item).toMatchObject({ status: "held", senderAddress: "stranger@example.org", mimeType: "application/pdf", receiptId: null });
    expect(Buffer.from(item.fileBlob ?? []).toString()).toBe(pdf("m1"));
  });

  it("does nothing when no mailbox is bound", async () => {
    configure({ ocr: okOcr() });
    send("m1");
    expect(await readMailbox()).toEqual({ status: "unbound" });
    expect(await db.receiptMailItem.count()).toBe(0);
  });

  it("takes the body as the receipt when there is no attachment, storing HTML as text", async () => {
    send("plain", { parts: [{ mimeType: "text/plain", body: { data: b64("Order 42 total $5") } }] });
    send("html", { parts: [{ mimeType: "text/html", body: { data: b64("<p>Order 43</p>") } }] });
    expect(await readMailbox()).toMatchObject({ receipts: 2 });
    const files = (await db.receipt.findMany()).map((r) => [r.mimeType, Buffer.from(r.fileBlob).toString()]);
    expect(files).toEqual(expect.arrayContaining([["text/plain", "Order 42 total $5"], ["text/plain", "<p>Order 43</p>"]]));
  });

  it("makes one receipt per accepted attachment and skips inline images and unaccepted types", async () => {
    send("m1", {
      parts: [
        { mimeType: "text/plain", body: { data: b64("two receipts") } },
        attachment("a", pdf("a")),
        attachment("b", pdf("b")),
        attachment("logo", "\x89PNG\r\n\x1a\n", { mimeType: "image/png", filename: "logo.png", headers: [{ name: "Content-Disposition", value: "inline" }] }),
        attachment("doc", "PK", { mimeType: "application/zip", filename: "x.zip" }),
      ],
    });
    expect(await readMailbox()).toMatchObject({ receipts: 2 });
  });

  it("refuses a file whose content does not match its type", async () => {
    send("m1", { parts: [attachment("fake", "not a pdf")] });
    expect(await readMailbox()).toMatchObject({ receipts: 0, held: 0, rejected: 1 });
  });

  it("stops at the per-run cap and takes the rest next run", async () => {
    for (let i = 0; i <= MAIL_CAP; i++) send(`m${i}`);
    expect(await readMailbox()).toMatchObject({ receipts: MAIL_CAP });
    expect(await readMailbox()).toMatchObject({ receipts: 1 });
  });
});

describeDb("mail intake sender authentication", () => {
  const heldAs = async (address: string) => {
    expect(await readMailbox()).toMatchObject({ receipts: 0, held: 1 });
    expect((await db.receiptMailItem.findFirstOrThrow()).senderAddress).toBe(address);
  };

  it("holds a message whose DMARC did not pass", async () => {
    send("m1", { auth: [GOOGLE_PASS.replace("dmarc=pass", "dmarc=fail")] });
    await heldAs("alice@example.org");
  });

  it("reads only the topmost Authentication-Results header, and only Google's", async () => {
    send("m1", { auth: [GOOGLE_PASS.replace("mx.google.com", "mx.example.net"), GOOGLE_PASS] });
    await heldAs("alice@example.org");
  });

  it("ignores a forged Google verdict below Google's real one", async () => {
    send("m1", { auth: [GOOGLE_PASS.replace("dmarc=pass", "dmarc=none"), GOOGLE_PASS] });
    await heldAs("alice@example.org");
  });

  it("holds a message with two From headers or two addresses", async () => {
    send("m1", { from: ["alice@example.org", "bob@example.org"] });
    send("m2", { from: ["alice@example.org, bob@example.org"] });
    expect(await readMailbox()).toMatchObject({ receipts: 0, held: 2 });
  });

  it("matches the address, never a display name naming a person", async () => {
    send("m1", { from: ['"alice@example.org" <mallory@example.org>'] });
    await heldAs("mallory@example.org");
  });

  it("never reads identity or files from a forwarded message", async () => {
    send("m1", {
      from: ["stranger@example.org"],
      parts: [
        { mimeType: "text/plain", body: { data: b64("fwd") } },
        {
          mimeType: "message/rfc822",
          headers: [{ name: "From", value: "alice@example.org" }],
          parts: [attachment("inner", pdf("inner"))],
        },
      ],
    });
    await heldAs("stranger@example.org");
    expect(Buffer.from((await db.receiptMailItem.findFirstOrThrow()).fileBlob ?? []).toString()).toBe("fwd");
  });
});
