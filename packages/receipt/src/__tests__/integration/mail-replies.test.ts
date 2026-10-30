import { beforeEach, expect, it } from "vitest";
import { db } from "../../db";
import type { MailAcknowledgement, MailboxReader, MailMessage } from "../../contract";
import { readMailbox } from "../../services/mailIntake";
import { mailQueueService } from "../../services/mailQueueService";
import { REPLY_ATTEMPTS, sendMailReplies } from "../../services/mailReplies";
import { describeDb } from "../helpers/db";
import { actAs, ALICE, BOB, clearAll, configure, FINANCE, okOcr } from "../helpers/setup";

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

const reader: MailboxReader = {
  listRecent: async () => [...messages.keys()],
  getMessage: async (id) => messages.get(id) ?? Promise.reject(new Error(`no message ${id}`)),
  getAttachment: async () => Buffer.alloc(0),
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

beforeEach(async () => {
  await clearAll();
  messages = new Map();
  sent = [];
  failSends = false;
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
  });
});

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

  it("owes nothing for a message whose every file is refused", async () => {
    messages.set("m1", {
      id: "m1",
      internalDate: String(Date.now()),
      payload: {
        mimeType: "multipart/mixed",
        headers: [{ name: "Authentication-Results", value: GOOGLE_PASS }, { name: "From", value: "alice@example.org" }],
        parts: [{ mimeType: "application/pdf", filename: "x.pdf", body: { data: Buffer.from("not a pdf").toString("base64url"), size: 9 } }],
      },
    });
    expect(await readMailbox()).toMatchObject({ rejected: 1 });
    expect(await db.receiptMailReply.count()).toBe(0);
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
