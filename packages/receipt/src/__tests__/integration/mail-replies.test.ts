import { beforeEach, expect, it } from "vitest";
import { db } from "../../db";
import type { MailAcknowledgement, MailboxReader, MailMessage, MailPart, ReceiptConfig } from "../../contract";
import { MAIL_CAP, MAIL_HELD_CEILING, readMailbox } from "../../services/mailIntake";
import { mailQueueService } from "../../services/mailQueueService";
import { REPLY_ATTEMPTS, sendMailReplies } from "../../services/mailReplies";
import { describeDb } from "../helpers/db";
import { actAs, ALICE, BOB, clearAll, configure, FINANCE, okOcr, TEST_ORG_ID } from "../helpers/setup";

const GOOGLE_PASS = "mx.google.com; dkim=pass header.i=@example.org; spf=pass; dmarc=pass header.from=example.org";
const GOOGLE_FAIL = "mx.google.com; dkim=fail; spf=fail; dmarc=fail header.from=example.org";
const PEOPLE: Record<string, typeof ALICE> = { "alice@example.org": ALICE, "bob@example.org": BOB };
const CONTACTS: Record<number, { email: string; name: string }> = {
  [ALICE.id]: { email: "alice@example.org", name: "Alice Adams" },
  [BOB.id]: { email: "bob@example.org", name: "Bob Baker" },
};

let messages: Map<string, MailMessage>;
let sent: MailAcknowledgement[];
let failSends: boolean;
let attachment: () => Promise<Buffer>;

const reader: MailboxReader = {
  listRecent: async () => [...messages.keys()],
  getMessage: async (id) => messages.get(id) ?? Promise.reject(new Error(`no message ${id}`)),
  getAttachment: async () => attachment(),
};

/** A message holding one PDF; `headers` adds to Google's verdict and the From. */
function send(id: string, { from = "alice@example.org", auth = GOOGLE_PASS, headers = [] as { name: string; value: string }[] } = {}): void {
  const data = Buffer.from(`%PDF-1.4 receipt ${id} ${Date.now()}`).toString("base64url");
  messages.set(id, {
    id,
    internalDate: String(Date.now()),
    payload: {
      mimeType: "multipart/mixed",
      headers: [{ name: "Authentication-Results", value: auth }, { name: "From", value: from }, ...headers],
      parts: [{ mimeType: "application/pdf", filename: `${id}.pdf`, body: { data, size: 40 } }],
    },
  });
}

const b64 = (text: string) => Buffer.from(text).toString("base64url");

/** A message holding the given parts. */
function mailWith(id: string, parts: MailPart[], { from = "alice@example.org", auth = GOOGLE_PASS, headers = [] as { name: string; value: string }[] } = {}): void {
  messages.set(id, {
    id,
    internalDate: String(Date.now()),
    payload: { mimeType: "multipart/mixed", headers: [{ name: "Authentication-Results", value: auth }, { name: "From", value: from }, ...headers], parts },
  });
}

beforeEach(async () => {
  await clearAll();
  messages = new Map();
  sent = [];
  failSends = false;
  attachment = async () => Buffer.alloc(0);
  setup();
});

async function fillToCeiling(): Promise<void> {
  await db.receiptMailItem.createMany({
    data: Array.from({ length: MAIL_HELD_CEILING }, (_, i) => ({
      orgId: TEST_ORG_ID, gmailMessageId: `old${i}`, attachmentHash: `h${i}`, receivedAt: new Date(), senderAddress: "x@example.org", status: "held", mimeType: "application/pdf", fileBlob: new Uint8Array([1]), dmarcVerdict: "pass",
    })),
  });
}

function setup(overrides: Partial<ReceiptConfig> = {}): void {
  configure({
    ocr: okOcr(),
    mailbox: reader,
    people: { submitterByEmail: async (address) => PEOPLE[address] ?? null },
    households: { householdOf: async () => [] },
    replies: {
      contactOf: async (id) => CONTACTS[id] ?? null,
      send: async (ack) => {
        sent.push(ack);
        return !failSends;
      },
    },
    ...overrides,
  });
}

describeDb("mailed receipt acknowledgements", () => {
  it("acknowledges a member's own receipt once, to them, across reruns", async () => {
    send("m1");
    expect(await readMailbox()).toMatchObject({ receipts: 1, replied: 1 });
    await readMailbox();
    const [receipt] = await db.receipt.findMany();
    expect(sent).toEqual([
      expect.objectContaining({ to: "alice@example.org", mine: true, creditedName: "Alice Adams", senderAddress: "alice@example.org", receiptId: receipt.id }),
    ]);
    expect(await db.receiptMailReply.count()).toBe(1);
  });

  it("sends nothing for held mail until finance assigns it, then tells the sender and the credited person apart", async () => {
    send("m1", { from: "helper@example.org" });
    await readMailbox();
    expect(sent).toEqual([]);

    actAs(FINANCE);
    const [item] = await db.receiptMailItem.findMany();
    await mailQueueService.assign(item.id, { email: "bob@example.org" });
    await readMailbox();
    expect(sent).toEqual([
      expect.objectContaining({ to: "helper@example.org", mine: false, creditedName: null }),
      expect.objectContaining({ to: "bob@example.org", mine: true, creditedName: "Bob Baker", senderAddress: "helper@example.org" }),
    ]);
  });

  it("never mails a sender whose DMARC failed, but still tells the credited person", async () => {
    send("m1", { from: "alice@example.org", auth: GOOGLE_FAIL });
    await readMailbox();
    actAs(FINANCE);
    const [item] = await db.receiptMailItem.findMany();
    await mailQueueService.assign(item.id, { email: "bob@example.org" });
    await sendMailReplies();
    expect(sent.map((a) => a.to)).toEqual(["bob@example.org"]);
  });

  it("tells the person a forged From names, once finance credits the receipt to them", async () => {
    send("m1", { from: "alice@example.org", auth: GOOGLE_FAIL });
    await readMailbox();
    actAs(FINANCE);
    const [item] = await db.receiptMailItem.findMany();
    await mailQueueService.assign(item.id, { email: "alice@example.org" });
    await sendMailReplies();
    expect(sent).toEqual([expect.objectContaining({ to: "alice@example.org", mine: true, creditedName: "Alice Adams", senderAddress: "alice@example.org" })]);
  });

  it("releases a row whose preparation throws, counts the attempt, and goes on with the batch", async () => {
    send("m1");
    send("m2", { from: "bob@example.org" });
    configure({ ocr: okOcr(), mailbox: reader, people: { submitterByEmail: async (a) => PEOPLE[a] ?? null } });
    await readMailbox();
    let throwOnce = true;
    configure({
      replies: {
        contactOf: async (id) => {
          if (id === ALICE.id && throwOnce) {
            throwOnce = false;
            throw new Error("database down");
          }
          return CONTACTS[id] ?? null;
        },
        send: async (ack) => {
          sent.push(ack);
          return true;
        },
      },
    });
    expect(await sendMailReplies()).toEqual({ sent: 1, failed: 1 });
    expect(sent.map((a) => a.to)).toEqual(["bob@example.org"]);
    const alice = await db.receiptMailReply.findUniqueOrThrow({ where: { gmailMessageId: "m1" } });
    expect(alice).toMatchObject({ claimedAt: null, attempts: 1, doneAt: null });
    await sendMailReplies();
    expect(sent.map((a) => a.to)).toEqual(["bob@example.org", "alice@example.org"]);
  });

  it("gives an automated message no sender copy, and still tells the credited person", async () => {
    send("m1", { headers: [{ name: "Auto-Submitted", value: "auto-replied" }] });
    send("m2", { from: "helper@example.org", headers: [{ name: "Precedence", value: "bulk" }] });
    await readMailbox();
    actAs(FINANCE);
    const held = await db.receiptMailItem.findFirstOrThrow({ where: { gmailMessageId: "m2" } });
    await mailQueueService.assign(held.id, { email: "bob@example.org" });
    await sendMailReplies();
    expect(sent).toEqual([
      expect.objectContaining({ to: "alice@example.org", mine: true, creditedName: "Alice Adams" }),
      expect.objectContaining({ to: "bob@example.org", mine: true, senderAddress: "helper@example.org" }),
    ]);
    expect(await db.receiptMailReply.findMany({ select: { replyToSender: true, doneAt: true } })).toEqual([
      { replyToSender: false, doneAt: expect.any(Date) },
      { replyToSender: false, doneAt: expect.any(Date) },
    ]);
  });

  it("sends nothing for a message whose file never becomes a receipt", async () => {
    send("m1", { from: "stranger@example.org" });
    await readMailbox();
    actAs(FINANCE);
    const [item] = await db.receiptMailItem.findMany();
    await mailQueueService.discard(item.id, { reason: "not a receipt" });
    await sendMailReplies();
    expect(sent).toEqual([]);
    expect(await db.receiptMailReply.findFirstOrThrow()).toMatchObject({ doneAt: expect.any(Date) });
  });

  it("keeps a reply owed while another file of the message is still held", async () => {
    const data = (s: string) => Buffer.from(`%PDF-1.4 ${s} ${Date.now()}`).toString("base64url");
    messages.set("m1", {
      id: "m1",
      internalDate: String(Date.now()),
      payload: {
        mimeType: "multipart/mixed",
        headers: [{ name: "Authentication-Results", value: GOOGLE_PASS }, { name: "From", value: "stranger@example.org" }],
        parts: ["a", "b"].map((n) => ({ mimeType: "application/pdf", filename: `${n}.pdf`, body: { data: data(n), size: 40 } })),
      },
    });
    await readMailbox();
    actAs(FINANCE);
    const [first, second] = await db.receiptMailItem.findMany({ orderBy: { id: "asc" } });
    await mailQueueService.discard(first.id, { reason: "logo" });
    expect(await db.receiptMailReply.findFirstOrThrow()).toMatchObject({ doneAt: null });
    await mailQueueService.assign(second.id, { email: "bob@example.org" });
    await sendMailReplies();
    expect(sent.map((a) => a.to)).toEqual(["stranger@example.org", "bob@example.org"]);
  });

  it("tells a verified sender why a file was refused, once across reruns, with no receipt", async () => {
    mailWith("m1", [{ mimeType: "application/pdf", filename: "x.pdf", body: { data: b64("not a pdf"), size: 9 } }]);
    expect(await readMailbox()).toMatchObject({ rejected: 1, replied: 1 });
    await readMailbox();
    await sendMailReplies();
    expect(sent).toEqual([
      expect.objectContaining({ to: "alice@example.org", receiptId: null, refused: [{ file: "x.pdf", reason: "wrong_type" }] }),
    ]);
    expect(await db.receiptMailReply.findFirstOrThrow()).toMatchObject({ refusalSentAt: expect.any(Date), doneAt: expect.any(Date) });
  });

  it("names each kind of refusal: too large, unaccepted type, empty, forwarded", async () => {
    mailWith("m1", [
      { mimeType: "application/pdf", filename: "big.pdf", body: { attachmentId: "a", size: 11 * 1024 * 1024 } },
      { mimeType: "application/msword", filename: "r.doc", body: { attachmentId: "b", size: 100 } },
      { mimeType: "application/pdf", filename: "empty.pdf", body: { data: "", size: 0 } },
      { mimeType: "message/rfc822", filename: "fwd.eml", body: { attachmentId: "c", size: 100 } },
    ]);
    await readMailbox();
    expect(sent).toHaveLength(1);
    expect(sent[0].refused).toEqual(
      expect.arrayContaining([
        { file: "big.pdf", reason: "too_large" },
        { file: "r.doc", reason: "wrong_type" },
        { file: "empty.pdf", reason: "empty" },
        { file: "fwd.eml", reason: "forwarded" },
      ]),
    );
  });

  it("does not treat a mail signature as a refused file", async () => {
    mailWith("m1", [{ mimeType: "application/pkcs7-signature", filename: "smime.p7s", body: { attachmentId: "a", size: 100 } }]);
    await readMailbox();
    expect(sent).toEqual([]);
  });

  it("tells a forged or unknown sender nothing about a refused file", async () => {
    const refused = [{ mimeType: "application/pdf", filename: "x.pdf", body: { data: b64("not a pdf"), size: 9 } }];
    mailWith("forged", refused, { auth: GOOGLE_FAIL });
    mailWith("unknown", refused, { from: "stranger@example.org" });
    mailWith("auto", refused, { headers: [{ name: "Auto-Submitted", value: "auto-replied" }] });
    await readMailbox();
    expect(sent).toEqual([]);
    expect(await db.receiptMailReply.count()).toBe(0);
  });

  it("covers accepted and refused files in one reply", async () => {
    mailWith("m1", [
      { mimeType: "application/pdf", filename: "good.pdf", body: { data: b64(`%PDF-1.4 good ${Date.now()}`), size: 30 } },
      { mimeType: "application/msword", filename: "r.doc", body: { attachmentId: "b", size: 100 } },
    ]);
    await readMailbox();
    await readMailbox();
    const [receipt] = await db.receipt.findMany();
    expect(sent).toEqual([
      expect.objectContaining({ to: "alice@example.org", mine: true, receiptId: receipt.id, refused: [{ file: "r.doc", reason: "wrong_type" }] }),
    ]);
  });

  it("does not hold a refusal for a deferred file, and acknowledges when its receipt appears", async () => {
    setup({ limits: { mailUploadsPerPersonPerDay: 0 } });
    mailWith("m1", [
      { mimeType: "application/pdf", filename: "good.pdf", body: { data: b64(`%PDF-1.4 good ${Date.now()}`), size: 30 } },
      { mimeType: "application/msword", filename: "r.doc", body: { attachmentId: "b", size: 100 } },
    ]);
    expect(await readMailbox()).toMatchObject({ overLimit: 1 });
    expect(sent).toEqual([expect.objectContaining({ receiptId: null, refused: [{ file: "r.doc", reason: "wrong_type" }] })]);

    setup();
    await readMailbox();
    await readMailbox();
    const [receipt] = await db.receipt.findMany();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ receiptId: receipt.id, refused: [] });
  });

  it("still sends a refusal that arrives after the acknowledgement, on its own", async () => {
    send("m1");
    await readMailbox();
    const [{ gmailMessageId }] = await db.receiptMailReply.findMany();
    const msg = messages.get(gmailMessageId)!;
    msg.payload.parts!.push({ mimeType: "application/msword", filename: "r.doc", body: { attachmentId: "b", size: 100 } });
    await readMailbox();
    await readMailbox();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ to: "alice@example.org", receiptId: null, refused: [{ file: "r.doc", reason: "wrong_type" }] });
  });

  it("does not write the refusals of a message with a file put off, until a pass finishes it", async () => {
    setup({ limits: { mailUploadsPerPersonPerDay: MAIL_CAP * 2 } });
    for (let i = 0; i < MAIL_CAP; i++) send(`a${i}`);
    mailWith("m1", [
      { mimeType: "application/pdf", filename: "later.pdf", body: { data: b64(`%PDF-1.4 later ${Date.now()}`), size: 30 } },
      { mimeType: "application/msword", filename: "r.doc", body: { attachmentId: "b", size: 100 } },
    ]);
    await readMailbox();
    expect(sent.filter((a) => a.refused.length > 0)).toEqual([]);
    await readMailbox();
    expect(sent.filter((a) => a.refused.length > 0)).toEqual([expect.objectContaining({ refused: [{ file: "r.doc", reason: "wrong_type" }] })]);
  });

  it("retries a refusal notice whose send failed, and sends one once it succeeds", async () => {
    failSends = true;
    mailWith("m1", [{ mimeType: "application/msword", filename: "r.doc", body: { attachmentId: "b", size: 100 } }]);
    await readMailbox();
    failSends = false;
    sent = [];
    await readMailbox();
    await readMailbox();
    expect(sent).toHaveLength(1);
  });

  it("keeps a refusal owed when finance discards the message's other file before it is sent", async () => {
    setup({ replies: undefined, limits: { mailUploadsPerPersonPerDay: 0 } });
    mailWith("m1", [
      { mimeType: "application/pdf", filename: "good.pdf", body: { data: b64(`%PDF-1.4 good ${Date.now()}`), size: 30 } },
      { mimeType: "application/msword", filename: "r.doc", body: { attachmentId: "b", size: 100 } },
    ]);
    await readMailbox();
    actAs(FINANCE);
    const [item] = await db.receiptMailItem.findMany();
    await mailQueueService.discard(item.id, { reason: "not a receipt" });
    expect((await db.receiptMailReply.findFirstOrThrow()).doneAt).toBeNull();
  });

  it("refuses a file finally at the held ceiling, tells the sender, and never reads it again", async () => {
    setup({ limits: { mailUploadsPerPersonPerDay: 0 } });
    await fillToCeiling();
    send("m1");
    expect(await readMailbox()).toMatchObject({ overCeiling: 1 });
    expect(sent).toEqual([expect.objectContaining({ receiptId: null, refused: [{ file: "m1.pdf", reason: "ceiling" }] })]);
    expect(await db.receiptMailItem.findFirstOrThrow({ where: { gmailMessageId: "m1" } })).toMatchObject({ status: "refused", fileBlob: null });
    expect(await readMailbox()).toMatchObject({ overCeiling: 0, skipped: 1 });
    expect(sent).toHaveLength(1);
  });

  it("still names a file refused at the ceiling when a later file's read failed on that pass", async () => {
    setup({ limits: { mailUploadsPerPersonPerDay: 0 } });
    await fillToCeiling();
    mailWith("m1", [
      { mimeType: "application/pdf", filename: "a.pdf", body: { data: b64(`%PDF-1.4 a ${Date.now()}`), size: 30 } },
      { mimeType: "application/pdf", filename: "b.pdf", body: { attachmentId: "b", size: 30 } },
    ]);
    attachment = () => Promise.reject(new Error("read failed"));
    expect(await readMailbox()).toMatchObject({ overCeiling: 1, failed: 1 });
    expect(sent).toEqual([]);

    setup();
    attachment = async () => Buffer.from(`%PDF-1.4 b ${Date.now()}`);
    await readMailbox();
    const [receipt] = await db.receipt.findMany();
    expect(sent).toEqual([expect.objectContaining({ receiptId: receipt.id, refused: [{ file: "a.pdf", reason: "ceiling" }] })]);
  });

  it("still names a stored refusal when every file of the message is already in the ledger", async () => {
    const bytes = Buffer.from("%PDF-1.4 a");
    mailWith("m1", [{ mimeType: "application/pdf", filename: "a.pdf", body: { data: bytes.toString("base64url"), size: bytes.length } }]);
    await db.receiptMailItem.create({
      data: {
        orgId: TEST_ORG_ID, gmailMessageId: "m1", attachmentHash: "h", receivedAt: new Date(), senderAddress: "alice@example.org", status: "refused", dmarcVerdict: "pass",
        refusal: { file: "a.pdf", reason: "ceiling" },
      },
    });
    expect(await readMailbox()).toMatchObject({ skipped: 1 });
    expect(sent).toEqual([expect.objectContaining({ receiptId: null, refused: [{ file: "a.pdf", reason: "ceiling" }] })]);
  });

  it("retries a send that reported failure, up to its limit, and stops", async () => {
    failSends = true;
    send("m1");
    await readMailbox();
    for (let i = 0; i < REPLY_ATTEMPTS + 2; i++) await sendMailReplies();
    expect(sent).toHaveLength(REPLY_ATTEMPTS);
    expect(await db.receiptMailReply.findFirstOrThrow()).toMatchObject({ attempts: REPLY_ATTEMPTS, doneAt: expect.any(Date), claimedAt: null });
  });

  it("resends only the copy that failed", async () => {
    send("m1", { from: "helper@example.org" });
    await readMailbox();
    actAs(FINANCE);
    const [item] = await db.receiptMailItem.findMany();
    await mailQueueService.assign(item.id, { email: "bob@example.org" });
    let calls = 0;
    configure({
      replies: {
        contactOf: async (id) => CONTACTS[id] ?? null,
        send: async (ack) => {
          sent.push(ack);
          return ++calls !== 2;
        },
      },
    });
    await sendMailReplies();
    await sendMailReplies();
    expect(sent.map((a) => a.to)).toEqual(["helper@example.org", "bob@example.org", "bob@example.org"]);
    expect(await db.receiptMailReply.findFirstOrThrow()).toMatchObject({ doneAt: expect.any(Date) });
  });

  it("never sends twice from a claimed row, as after a crash between send and stamp", async () => {
    send("m1");
    configure({ ocr: okOcr(), mailbox: reader, people: { submitterByEmail: async (a) => PEOPLE[a] ?? null } });
    await readMailbox();
    await db.receiptMailReply.updateMany({ data: { claimedAt: new Date() } });
    configure({
      replies: {
        contactOf: async (id) => CONTACTS[id] ?? null,
        send: async (ack) => {
          sent.push(ack);
          return true;
        },
      },
    });
    await sendMailReplies();
    expect(sent).toEqual([]);
  });

  it("keeps acknowledgements waiting while the host's mail out is unbound", async () => {
    configure({ ocr: okOcr(), mailbox: reader, people: { submitterByEmail: async (a) => PEOPLE[a] ?? null } });
    send("m1");
    expect(await readMailbox()).toMatchObject({ receipts: 1, replied: 0 });
    expect(await db.receiptMailReply.findFirstOrThrow()).toMatchObject({ attempts: 0, doneAt: null });
  });
});
