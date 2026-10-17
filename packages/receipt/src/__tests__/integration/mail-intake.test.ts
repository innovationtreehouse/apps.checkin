import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { db } from "../../db";
import type { MailboxReader, MailHoldCeilingEvent, MailMessage, MailPart } from "../../contract";
import { MAX_FILE_BYTES } from "../../lib/file-type";
import {
  MAIL_CAP,
  MAIL_HELD_BYTES,
  MAIL_HELD_CAP,
  MAIL_HELD_CEILING,
  MAIL_TIME_BUDGET_MS,
  readMailbox,
} from "../../services/mailIntake";
import { describeDb } from "../helpers/db";
import type { ReceiptLimits } from "../../lib/limits";
import { ALICE, BOB, clearAll, configure, okOcr, stateOf, TEST_ORG_ID } from "../helpers/setup";

const GOOGLE_PASS = "mx.google.com; dkim=pass header.i=@example.org; spf=pass; dmarc=pass (p=NONE sp=NONE) header.from=example.org";
const b64 = (s: string) => Buffer.from(s).toString("base64url");
const pdf = (label: string) => `%PDF-1.4 receipt ${label}`;

/** A fake Gmail mailbox: messages by id, attachments by id, and the ids of attachments downloaded. */
function fakeMailbox() {
  const messages = new Map<string, MailMessage>();
  const attachments = new Map<string, string>();
  const downloads: string[] = [];
  const reader: MailboxReader = {
    listRecent: async () => [...messages.keys()],
    getMessage: async (id) => messages.get(id) ?? Promise.reject(new Error(`no message ${id}`)),
    getAttachment: async (_messageId, attachmentId) => {
      downloads.push(attachmentId);
      return Buffer.from(attachments.get(attachmentId) ?? "");
    },
  };
  return { messages, attachments, downloads, reader };
}

let mail: ReturnType<typeof fakeMailbox>;
let alerts: MailHoldCeilingEvent[];

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
  alerts = [];
  configure({
    ocr: okOcr(),
    mailbox: mail.reader,
    alerts: { mailHoldCeilingReached: async (event) => void alerts.push(event) },
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

  it("stops at the per-run cap, oldest mail first, and takes the rest next run", async () => {
    for (let i = 0; i <= MAIL_CAP; i++) send(`m${i}`);
    expect(await readMailbox()).toMatchObject({ receipts: MAIL_CAP });
    const read = (await db.receiptMailItem.findMany()).map((m) => m.gmailMessageId);
    expect(read).toContain("m0");
    expect(read).not.toContain(`m${MAIL_CAP}`);
    expect(await readMailbox()).toMatchObject({ receipts: 1 });
  });

  it("holds any number of untrusted messages without starving a member's receipt", async () => {
    for (let i = 0; i < MAIL_CAP; i++) send(`spam${i}`, { from: [`stranger${i}@example.org`] });
    send("member");
    for (let i = 0; i < MAIL_CAP; i++) send(`later${i}`, { from: [`other${i}@example.org`] });
    expect(await readMailbox()).toMatchObject({ receipts: 1, held: 2 * MAIL_CAP });
    expect((await db.receipt.findFirstOrThrow()).uploadedByUserId).toBe(ALICE.id);
  });
});

describeDb("mail intake flood limits", () => {
  const stranger = (id: string, over: Partial<MailPart> = {}) =>
    send(id, { from: [`${id}@example.org`], parts: [attachment(`att-${id}`, pdf(id), over)] });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("checks the ledger before downloading a message's files", async () => {
    send("m1");
    await readMailbox();
    mail.downloads.length = 0;
    expect(await readMailbox()).toMatchObject({ receipts: 0, skipped: 1 });
    expect(mail.downloads).toEqual([]);
  });

  it("holds at most MAIL_HELD_CAP files per run, counts the rest, and never downloads them", async () => {
    for (let i = 0; i < MAIL_HELD_CAP + 2; i++) stranger(`s${i}`);
    send("member");
    expect(await readMailbox()).toMatchObject({ receipts: 1, held: MAIL_HELD_CAP, deferred: 2 });
    expect(mail.downloads).toHaveLength(MAIL_HELD_CAP + 1);
    expect(await readMailbox()).toMatchObject({ held: 2, deferred: 0 });
  });

  it("stops holding at the per-run byte budget", async () => {
    const fit = Math.floor(MAIL_HELD_BYTES / MAX_FILE_BYTES);
    for (let i = 0; i <= fit; i++) stranger(`s${i}`, { body: { attachmentId: `att-s${i}`, size: MAX_FILE_BYTES } });
    expect(await readMailbox()).toMatchObject({ held: fit, deferred: 1 });
  });

  it("charges an unknown sender's rejected files to the held budget, so junk cannot crowd out a receipt", async () => {
    for (let i = 0; i < MAIL_HELD_CAP + 5; i++) send(`junk${i}`, { from: [`junk${i}@example.org`], parts: [attachment(`att-junk${i}`, "not a pdf")] });
    send("member");
    expect(await readMailbox()).toMatchObject({ receipts: 1, held: 0, rejected: MAIL_HELD_CAP, deferred: 5 });
    expect(mail.downloads).toHaveLength(MAIL_HELD_CAP + 1);
  });

  it("charges a rejected file's stated size to the byte budget", async () => {
    const fit = Math.floor(MAIL_HELD_BYTES / MAX_FILE_BYTES);
    for (let i = 0; i <= fit; i++) {
      send(`junk${i}`, { from: [`junk${i}@example.org`], parts: [attachment(`att-junk${i}`, "not a pdf", { body: { attachmentId: `att-junk${i}`, size: MAX_FILE_BYTES } })] });
    }
    expect(await readMailbox()).toMatchObject({ rejected: fit, deferred: 1 });
    expect(mail.downloads).toHaveLength(fit);
  });

  it("past the held ceiling, holds nothing new, alerts finance, and still reads receipts", async () => {
    await db.receiptMailItem.createMany({
      data: Array.from({ length: MAIL_HELD_CEILING }, (_, i) => ({
        orgId: TEST_ORG_ID,
        gmailMessageId: `old${i}`,
        attachmentHash: `h${i}`,
        receivedAt: new Date(),
        senderAddress: "old@example.org",
      })),
    });
    stranger("s1");
    send("member");
    expect(await readMailbox()).toMatchObject({ receipts: 1, held: 0, overCeiling: 1 });
    expect(mail.downloads).toEqual(["att-member"]);
    expect(alerts).toEqual([{ orgId: TEST_ORG_ID, unresolved: MAIL_HELD_CEILING, refused: 1 }]);
  });

  it("refuses an attachment over the upload size limit without downloading it", async () => {
    send("m1", { parts: [attachment("big", pdf("big"), { body: { attachmentId: "big", size: MAX_FILE_BYTES + 1 } })] });
    expect(await readMailbox()).toMatchObject({ receipts: 0, held: 0, rejected: 1 });
    expect(mail.downloads).toEqual([]);
  });

  it("stops at the time budget and leaves the rest for the next run", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    send("m1");
    send("m2");
    const { getMessage } = mail.reader;
    mail.reader.getMessage = async (id) => {
      vi.setSystemTime(Date.now() + MAIL_TIME_BUDGET_MS);
      return getMessage(id);
    };
    expect(await readMailbox()).toMatchObject({ messages: 1, receipts: 1, unread: 1 });
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

describeDb("mail intake over a sender's daily upload limit", () => {
  const people: Record<string, typeof ALICE> = { "alice@example.org": ALICE, "bob@example.org": BOB };
  let lookups: string[];

  function withLimits(limits: Partial<ReceiptLimits>, known = people): void {
    lookups = [];
    configure({
      ocr: okOcr(),
      mailbox: mail.reader,
      alerts: { mailHoldCeilingReached: async (event) => void alerts.push(event) },
      limits,
      people: {
        submitterByEmail: async (address) => {
          lookups.push(address);
          return known[address] ?? null;
        },
      },
    });
  }

  let seq = 0;
  async function deferredFor(address: string): Promise<number> {
    const n = ++seq;
    const row = await db.receiptMailItem.create({
      data: {
        orgId: TEST_ORG_ID,
        gmailMessageId: `old${n}`,
        attachmentHash: `h${n}`,
        receivedAt: new Date(Date.now() - 60_000 + n),
        senderAddress: address,
        status: "deferred",
        fileBlob: new Uint8Array(Buffer.from(pdf(`deferred ${n}`))),
        mimeType: "application/pdf",
      },
    });
    return row.id;
  }

  it("defers the file with its bytes, then makes it a receipt on a later run once the sender has allowance", async () => {
    withLimits({ uploadsPerPersonPerDay: 1 });
    send("m1");
    send("m2");
    expect(await readMailbox()).toMatchObject({ receipts: 1, held: 0, overLimit: 1 });
    const deferred = await db.receiptMailItem.findFirstOrThrow({ where: { status: "deferred" } });
    expect(deferred).toMatchObject({ gmailMessageId: "m2", senderAddress: "alice@example.org", receiptId: null });
    expect(Buffer.from(deferred.fileBlob ?? []).toString()).toBe(pdf("m2"));

    expect(await readMailbox()).toMatchObject({ receipts: 0, overLimit: 0, skipped: 2 });

    withLimits({ uploadsPerPersonPerDay: 30 });
    mail.messages.clear();
    expect(await readMailbox()).toMatchObject({ receipts: 1 });
    const item = await db.receiptMailItem.findUniqueOrThrow({ where: { id: deferred.id } });
    expect(item).toMatchObject({ status: "assigned", fileBlob: null });
    const receipt = await db.receipt.findUniqueOrThrow({ where: { id: item.receiptId ?? "" } });
    expect(receipt).toMatchObject({ uploadedByUserId: ALICE.id, intakeSource: "email" });
  });

  it("spends no cap and no reading on a refused retry, and skips that sender's other deferred files for the run", async () => {
    withLimits({ uploadsPerPersonPerDay: 1 });
    send("a0");
    expect(await readMailbox()).toMatchObject({ receipts: 1 });
    mail.messages.clear();
    for (let i = 0; i <= MAIL_CAP; i++) await deferredFor("alice@example.org");
    send("bob1", { from: ["bob@example.org"] });
    withLimits({ uploadsPerPersonPerDay: 1 });

    expect(await readMailbox()).toMatchObject({ receipts: 1, failed: 0 });
    expect(lookups.filter((a) => a === "alice@example.org")).toHaveLength(1);
    expect(await db.receiptMailItem.count({ where: { status: "deferred" } })).toBe(MAIL_CAP + 1);
    expect(await db.receiptAuditLog.count({ where: { action: "ocr_call", userId: ALICE.id } })).toBe(1);
    expect((await db.receipt.findFirstOrThrow({ where: { uploadedByUserId: BOB.id } })).intakeSource).toBe("email");
  });

  it("stops every retry for the run once the org-wide upload limit refuses one", async () => {
    await deferredFor("alice@example.org");
    await deferredFor("bob@example.org");
    withLimits({ uploadBytesPerDay: 0 });
    expect(await readMailbox()).toMatchObject({ receipts: 0, failed: 0 });
    expect(lookups).toEqual(["alice@example.org"]);
  });

  it("holds a deferred file for finance once its sender is no longer a submitter", async () => {
    const id = await deferredFor("alice@example.org");
    withLimits({}, {});
    expect(await readMailbox()).toMatchObject({ receipts: 0 });
    expect(await db.receiptMailItem.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "held" });
  });

  it("counts deferred files toward the held ceiling", async () => {
    withLimits({ uploadsPerPersonPerDay: 0 });
    await db.receiptMailItem.createMany({
      data: Array.from({ length: MAIL_HELD_CEILING }, (_, i) => ({
        orgId: TEST_ORG_ID,
        gmailMessageId: `full${i}`,
        attachmentHash: `f${i}`,
        receivedAt: new Date(),
        senderAddress: i === 0 ? "alice@example.org" : "stranger@example.org",
        status: i === 0 ? "deferred" : "held",
      })),
    });
    send("m1");
    expect(await readMailbox()).toMatchObject({ overLimit: 0, overCeiling: 1 });
    expect(alerts).toHaveLength(1);
  });
});
