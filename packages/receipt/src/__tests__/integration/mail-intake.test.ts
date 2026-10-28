import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { db } from "../../db";
import type { MailAgingOutEvent, MailboxReader, MailHoldCeilingEvent, MailMessage, MailPart } from "../../contract";
import { MAX_FILE_BYTES } from "../../lib/file-type";
import {
  MAIL_CAP,
  MAIL_HELD_BYTES,
  MAIL_HELD_CAP,
  MAIL_HELD_CEILING,
  MAIL_TIME_BUDGET_MS,
  MAIL_WINDOW_DAYS,
  INLINE_FLOOR_BYTES,
  readMailbox,
} from "../../services/mailIntake";
import { describeDb } from "../helpers/db";
import type { ReceiptLimits } from "../../lib/limits";
import { receiptService } from "../../services/receiptService";
import { actAs, ALICE, BOB, clearAll, configure, manualDetails, okOcr, stateOf, TEST_ORG_ID, textFile } from "../helpers/setup";

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
let agingAlerts: MailAgingOutEvent[];
const DAY_MS = 24 * 60 * 60_000;

const attachment = (id: string, content: string, over: Partial<MailPart> = {}): MailPart => {
  mail.attachments.set(id, content);
  return { mimeType: "application/pdf", filename: `${id}.pdf`, body: { attachmentId: id, size: content.length }, ...over };
};

/** A message; `auth` lists its Authentication-Results headers top first, `from` its From headers, `ageMs` how long ago it arrived. */
function send(
  id: string,
  {
    from = ["Alice <alice@example.org>"],
    auth = [GOOGLE_PASS],
    parts,
    ageMs = 0,
  }: { from?: string[]; auth?: string[]; parts?: MailPart[]; ageMs?: number } = {},
): void {
  mail.messages.set(id, {
    id,
    internalDate: String(Date.now() - ageMs),
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

const testAlerts = () => ({
  mailHoldCeilingReached: async (event: MailHoldCeilingEvent) => void alerts.push(event),
  mailAgingOut: async (event: MailAgingOutEvent) => void agingAlerts.push(event),
});

beforeEach(async () => {
  await clearAll();
  mail = fakeMailbox();
  alerts = [];
  agingAlerts = [];
  configure({
    ocr: okOcr(),
    mailbox: mail.reader,
    alerts: testAlerts(),
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
    expect(item).toMatchObject({ status: "held", holdReason: "not_a_submitter", senderAddress: "stranger@example.org", mimeType: "application/pdf", receiptId: null });
    expect(Buffer.from(item.fileBlob ?? []).toString()).toBe(pdf("m1"));
  });

  it("does nothing when no mailbox is bound", async () => {
    configure({ ocr: okOcr() });
    send("m1");
    expect(await readMailbox()).toEqual({ status: "unbound" });
    expect(await db.receiptMailItem.count()).toBe(0);
  });

  it("takes a body holding a money amount as a receipt, storing HTML as text", async () => {
    send("plain", { parts: [{ mimeType: "text/plain", body: { data: b64("Order 42 total $5.00") } }] });
    send("html", { parts: [{ mimeType: "text/html", body: { data: b64("<p>Order 43 total 7.50</p>") } }] });
    expect(await readMailbox()).toMatchObject({ receipts: 2, ignored: 0 });
    const files = (await db.receipt.findMany()).map((r) => [r.mimeType, Buffer.from(r.fileBlob).toString()]);
    expect(files).toEqual(expect.arrayContaining([["text/plain", "Order 42 total $5.00"], ["text/plain", "<p>Order 43 total 7.50</p>"]]));
  });

  it("skips a trivial body, one with no money amount, and counts it ignored", async () => {
    send("m1", { parts: [{ mimeType: "text/plain", body: { data: b64("For the lathe, total $5") } }] });
    expect(await readMailbox()).toMatchObject({ receipts: 0, held: 0, ignored: 1 });
    expect(await db.receiptMailItem.count()).toBe(0);
  });

  /** The message's receipts in ledger order, as [mimeType, state]. */
  const messageReceipts = async () => {
    const items = await db.receiptMailItem.findMany({ orderBy: { id: "asc" }, select: { receiptId: true } });
    return Promise.all(
      items.map(async (i) => {
        const r = await db.receipt.findUniqueOrThrow({ where: { id: i.receiptId ?? "" } });
        return [r.id, r.mimeType, await stateOf(r.id)];
      }),
    );
  };

  it("reads a body after the attachments, and discards it when its reading repeats one", async () => {
    send("m1", { parts: [{ mimeType: "text/plain", body: { data: b64("Order total 5.00") } }, attachment("a", pdf("a"))] });
    expect(await readMailbox()).toMatchObject({ receipts: 2 });
    const [[pdfId, pdfType], [bodyId, bodyType, bodyState]] = await messageReceipts();
    expect([pdfType, bodyType, bodyState]).toEqual(["application/pdf", "text/plain", "discarded"]);
    expect(await stateOf(pdfId as string)).not.toBe("discarded");
    expect(await db.receiptAuditLog.findFirst({ where: { receiptId: bodyId as string, action: "body_copy_discarded" } })).toMatchObject({
      userId: null,
      valueAfter: `same as attachment ${pdfId}`,
    });
    actAs(ALICE);
    await receiptService.submitterConfirm(pdfId as string);
    expect(await stateOf(pdfId as string)).not.toBe("duplicate_flagged");
  });

  it("keeps a body whose reading differs from every attachment's", async () => {
    configure({
      ocr: { extract: (file, mimeType) => okOcr(mimeType === "text/plain" ? { receiptTotal: 9 } : {}).extract(file, mimeType) },
      mailbox: mail.reader,
      people: { submitterByEmail: async (address) => (address === "alice@example.org" ? ALICE : null) },
    });
    send("m1", { parts: [{ mimeType: "text/plain", body: { data: b64("Order total 9.00") } }, attachment("a", pdf("a"))] });
    expect(await readMailbox()).toMatchObject({ receipts: 2 });
    expect((await messageReceipts()).map(([, , state]) => state)).not.toContain("discarded");
  });

  it("reads inline images of an accepted type, skips those under the floor unread, and skips unaccepted types", async () => {
    const gif = (n: number) => "GIF89a".padEnd(n, "x");
    const inline = [{ name: "Content-Disposition", value: "inline" }];
    send("m1", {
      parts: [
        { mimeType: "text/plain", body: { data: b64("see photos") } },
        attachment("a", pdf("a")),
        attachment("photo", gif(INLINE_FLOOR_BYTES), { mimeType: "image/gif", filename: "photo.gif", headers: inline }),
        attachment("pasted", gif(INLINE_FLOOR_BYTES + 1), { mimeType: "image/gif", filename: undefined }),
        attachment("logo", gif(16), { mimeType: "image/gif", filename: "logo.png", headers: inline }),
        attachment("doc", "PK", { mimeType: "application/zip", filename: "x.zip" }),
      ],
    });
    expect(await readMailbox()).toMatchObject({ receipts: 3, ignored: 2 });
    expect(mail.downloads).not.toContain("logo");
  });

  it("skips a file on the org's ignore list, charges it like a rejected one, and ledgers it as discarded", async () => {
    const logo = pdf("logo");
    await db.receiptIgnoredFile.create({
      data: { orgId: TEST_ORG_ID, fileHash: createHash("sha256").update(logo).digest("hex"), reason: "newsletter logo", addedByUserId: 1 },
    });
    for (let i = 0; i < MAIL_HELD_CAP + 1; i++) send(`n${i}`, { from: [`news${i}@example.org`], parts: [attachment(`att-n${i}`, logo)] });
    send("member", { parts: [attachment("logo-from-alice", logo), attachment("real", pdf("real"))] });
    expect(await readMailbox()).toMatchObject({ receipts: 1, held: 0, ignored: MAIL_HELD_CAP + 1, deferred: 1 });
    expect(await db.receiptMailItem.count({ where: { status: "discarded", fileBlob: null } })).toBe(MAIL_HELD_CAP + 1);

    mail.downloads.length = 0;
    expect(await readMailbox()).toMatchObject({ receipts: 0, ignored: 1, skipped: MAIL_HELD_CAP + 2 });
    expect(mail.downloads).toEqual([`att-n${MAIL_HELD_CAP}`]);
  });

  it("refuses a file whose content does not match its type", async () => {
    send("m1", { parts: [attachment("fake", "not a pdf")] });
    expect(await readMailbox()).toMatchObject({ receipts: 0, held: 0, rejected: 1 });
  });

  it("stops at the per-run cap, oldest mail first, and takes the rest next run", async () => {
    configure({ ocr: okOcr(), mailbox: mail.reader, people: { submitterByEmail: async () => ({ ...ALICE, raisedMailLimit: true }) } });
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
    expect(agingAlerts).toEqual([]);
  });
});

describeDb("mail intake ageing alert", () => {
  const old = (MAIL_WINDOW_DAYS - 1) * DAY_MS + 60_000;
  const raised = () =>
    configure({ ocr: okOcr(), mailbox: mail.reader, alerts: testAlerts(), people: { submitterByEmail: async () => ({ ...ALICE, raisedMailLimit: true }) } });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("alerts finance once when mail older than two days is put off by the cap", async () => {
    raised();
    for (let i = 0; i <= MAIL_CAP; i++) send(`m${i}`, { ageMs: old });
    await readMailbox();
    expect(agingAlerts).toHaveLength(1);
    expect(agingAlerts[0]).toMatchObject({ orgId: TEST_ORG_ID, messages: 1 });
    expect(agingAlerts[0].oldestReceivedAt).toBeInstanceOf(Date);
  });

  it("stays quiet when the mail put off is recent enough for the next run", async () => {
    raised();
    for (let i = 0; i <= MAIL_CAP; i++) send(`m${i}`);
    await readMailbox();
    expect(agingAlerts).toEqual([]);
  });

  it("alerts for old mail the run never reached, counting every unread message", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    send("m1", { ageMs: old + 2_000 });
    send("m2", { ageMs: old + 1_000 });
    send("m3", { ageMs: old });
    const { getMessage } = mail.reader;
    let first = true;
    mail.reader.getMessage = async (id) => {
      if (first) vi.setSystemTime(Date.now() + MAIL_TIME_BUDGET_MS);
      first = false;
      return getMessage(id);
    };
    expect(await readMailbox()).toMatchObject({ messages: 1, unread: 2 });
    expect(agingAlerts).toMatchObject([{ messages: 2 }]);
  });

  it("alerts for a message that cannot be fetched, since its age is unknown, keeping the known oldest date", async () => {
    raised();
    for (let i = 0; i <= MAIL_CAP; i++) send(`m${i}`, { ageMs: old });
    const { getMessage } = mail.reader;
    const listRecent = mail.reader.listRecent;
    mail.reader.listRecent = async (days) => [...(await listRecent(days)), "gone"];
    mail.reader.getMessage = async (id) => (id === "gone" ? Promise.reject(new Error("Gmail request failed: 500")) : getMessage(id));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await readMailbox()).toMatchObject({ failed: 1 });
    expect(agingAlerts).toMatchObject([{ messages: 2 }]);
    expect(agingAlerts[0].oldestReceivedAt).toBeInstanceOf(Date);
  });

  it("alerts for an old message whose reading failed", async () => {
    send("m1", { ageMs: old });
    configure({
      ocr: okOcr(),
      mailbox: mail.reader,
      alerts: testAlerts(),
      people: {
        submitterByEmail: async () => {
          throw new Error("people lookup down");
        },
      },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await readMailbox()).toMatchObject({ failed: 1 });
    expect(agingAlerts).toMatchObject([{ messages: 1 }]);
  });
});

describeDb("mail intake sender authentication", () => {
  const heldAs = async (address: string) => {
    expect(await readMailbox()).toMatchObject({ receipts: 0, held: 1 });
    expect((await db.receiptMailItem.findFirstOrThrow()).senderAddress).toBe(address);
  };

  it("holds a message whose DMARC did not pass, recording that the sender is unverified", async () => {
    send("m1", { auth: [GOOGLE_PASS.replace("dmarc=pass", "dmarc=fail")] });
    await heldAs("alice@example.org");
    expect((await db.receiptMailItem.findFirstOrThrow()).holdReason).toBe("unverified_sender");
  });

  it("holds a member's message that passed DMARC on SPF alone, with no aligned DKIM signature", async () => {
    send("m1", { auth: ["mx.google.com; dkim=pass header.i=@mailer.example.net; spf=pass; dmarc=pass header.from=example.org"] });
    send("m2", { auth: ["mx.google.com; spf=pass; dmarc=pass header.from=example.org"] });
    expect(await readMailbox()).toMatchObject({ receipts: 0, held: 2 });
    expect((await db.receiptMailItem.findMany()).map((i) => i.holdReason)).toEqual(["unverified_sender", "unverified_sender"]);
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
        { mimeType: "text/plain", body: { data: b64("fwd total 9.99") } },
        {
          mimeType: "message/rfc822",
          headers: [{ name: "From", value: "alice@example.org" }],
          parts: [attachment("inner", pdf("inner"))],
        },
      ],
    });
    await heldAs("stranger@example.org");
    expect(Buffer.from((await db.receiptMailItem.findFirstOrThrow()).fileBlob ?? []).toString()).toBe("fwd total 9.99");
  });

  it("never opens a message forwarded as an attachment, and counts it ignored", async () => {
    send("m1", {
      parts: [
        { mimeType: "text/plain", body: { data: b64("see attached") } },
        { mimeType: "message/rfc822", filename: "receipt.eml", parts: [{ mimeType: "text/plain", body: { data: b64("Order total 12.00") } }] },
      ],
    });
    expect(await readMailbox()).toMatchObject({ receipts: 0, held: 0, ignored: 2 });
    expect(await db.receiptMailItem.count()).toBe(0);
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
      alerts: testAlerts(),
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
    withLimits({ mailUploadsPerPersonPerDay: 1 });
    send("m1");
    send("m2");
    expect(await readMailbox()).toMatchObject({ receipts: 1, held: 0, overLimit: 1 });
    const deferred = await db.receiptMailItem.findFirstOrThrow({ where: { status: "deferred" } });
    expect(deferred).toMatchObject({ gmailMessageId: "m2", senderAddress: "alice@example.org", receiptId: null });
    expect(Buffer.from(deferred.fileBlob ?? []).toString()).toBe(pdf("m2"));

    expect(await readMailbox()).toMatchObject({ receipts: 0, overLimit: 0, skipped: 2 });

    withLimits({ mailUploadsPerPersonPerDay: 30 });
    mail.messages.clear();
    expect(await readMailbox()).toMatchObject({ receipts: 1 });
    const item = await db.receiptMailItem.findUniqueOrThrow({ where: { id: deferred.id } });
    expect(item).toMatchObject({ status: "assigned", fileBlob: null });
    const receipt = await db.receipt.findUniqueOrThrow({ where: { id: item.receiptId ?? "" } });
    expect(receipt).toMatchObject({ uploadedByUserId: ALICE.id, intakeSource: "email" });
  });

  it("discards a deferred body that repeats its message's attachment once it is retried", async () => {
    withLimits({ mailUploadsPerPersonPerDay: 1 });
    send("m1", { parts: [{ mimeType: "text/plain", body: { data: b64("Order total 5.00") } }, attachment("a", pdf("a"))] });
    expect(await readMailbox()).toMatchObject({ receipts: 1, overLimit: 1 });

    withLimits({ mailUploadsPerPersonPerDay: 30 });
    mail.messages.clear();
    expect(await readMailbox()).toMatchObject({ receipts: 1 });
    const body = await db.receiptMailItem.findFirstOrThrow({ where: { gmailMessageId: "m1" }, orderBy: { id: "desc" } });
    expect(await stateOf(body.receiptId ?? "")).toBe("discarded");
  });

  it("spends no cap and no reading on a refused retry, and skips that sender's other deferred files for the run", async () => {
    withLimits({ mailUploadsPerPersonPerDay: 1 });
    send("a0");
    expect(await readMailbox()).toMatchObject({ receipts: 1 });
    mail.messages.clear();
    for (let i = 0; i <= MAIL_CAP; i++) await deferredFor("alice@example.org");
    send("bob1", { from: ["bob@example.org"] });
    withLimits({ mailUploadsPerPersonPerDay: 1 });

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
    expect(await db.receiptMailItem.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "held", holdReason: "not_a_submitter" });
  });

  it("counts deferred files toward the held ceiling", async () => {
    withLimits({ mailUploadsPerPersonPerDay: 0 });
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

  it("gives a program lead or Board member the raised mail limit", async () => {
    withLimits({ mailUploadsPerPersonPerDay: 1, mailUploadsPerRaisedPersonPerDay: 2 }, { "alice@example.org": { ...ALICE, raisedMailLimit: true } });
    send("m1");
    send("m2");
    send("m3");
    expect(await readMailbox()).toMatchObject({ receipts: 2, overLimit: 1 });
  });

  it("counts mailed receipts toward the manual upload limit", async () => {
    withLimits({ uploadsPerPersonPerDay: 1 });
    send("m1");
    expect(await readMailbox()).toMatchObject({ receipts: 1 });
    await expect(receiptService.upload(textFile(), "text/plain", { details: manualDetails() })).rejects.toMatchObject({ status: 429 });
  });

  it("counts only mailed receipts toward the mail limit", async () => {
    withLimits({ uploadsPerPersonPerDay: 2, mailUploadsPerPersonPerDay: 1 });
    await receiptService.upload(textFile(), "text/plain", { details: manualDetails() });
    send("m1");
    send("m2");
    expect(await readMailbox()).toMatchObject({ receipts: 1, overLimit: 1 });
  });
});
