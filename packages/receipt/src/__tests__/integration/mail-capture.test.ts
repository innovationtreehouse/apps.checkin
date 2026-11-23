import { createHash } from "node:crypto";
import { KindedError } from "@checkin/component-kit";
import { beforeEach, expect, it, vi } from "vitest";
import { db } from "../../db";
import type { MailboxReader, MailMessage } from "../../contract";
import { createMemoryFileStore } from "../../lib/fileStorage";
import { processCapturedMessage, readMailbox } from "../../services/mailIntake";
import { mailQueueService } from "../../services/mailQueueService";
import { MAIL_STILL_STUCK, retryStuckItem, stuckItems, WAITING_NOTICE_MS } from "../../stuckItems";
import { describeDb } from "../helpers/db";
import { toRaw } from "../helpers/mime";
import { actAs, ALICE, clearAll, configure, FINANCE, okOcr, TEST_ORG_ID } from "../helpers/setup";

const GOOGLE_PASS = "mx.google.com; dkim=pass header.i=@example.org; spf=pass; dmarc=pass header.from=example.org";
const DAY_MS = 24 * 60 * 60_000;
const pdf = (label: string) => `%PDF-1.4 receipt ${label}`;
const b64 = (s: string) => Buffer.from(s).toString("base64url");

let messages: Map<string, MailMessage>;
let fetched: string[];
/** Each raw message as last fetched. */
let raws: Map<string, Buffer>;
let store: ReturnType<typeof createMemoryFileStore>;

const reader: MailboxReader = {
  address: "receipts@example.org",
  listRecent: async () => [...messages.keys()],
  getRaw: async (id) => {
    fetched.push(id);
    const msg = messages.get(id);
    if (!msg) throw new Error(`no message ${id}`);
    const raw = toRaw(msg);
    raws.set(id, raw);
    return { raw, internalDate: msg.internalDate };
  },
};

/** A message from Alice holding a PDF per label. */
function send(id: string, labels = [id]): void {
  messages.set(id, {
    id,
    internalDate: String(Date.now()),
    payload: {
      mimeType: "multipart/mixed",
      headers: [{ name: "Authentication-Results", value: GOOGLE_PASS }, { name: "From", value: "alice@example.org" }],
      parts: labels.map((l) => ({ mimeType: "application/pdf", filename: `${l}.pdf`, body: { data: b64(pdf(l)) } })),
    },
  });
}

function bind(over: Parameters<typeof configure>[0] = {}): void {
  configure({ ocr: okOcr(), mailbox: reader, fileStore: store, people: { submitterByEmail: async () => ALICE }, ...over });
}

/** Everything a message's processing makes, to compare before and after a replay. */
const made = async () => ({
  receipts: await db.receipt.count(),
  items: await db.receiptMailItem.count(),
  replies: await db.receiptMailReply.count(),
  objects: store.objects.size,
});

beforeEach(async () => {
  await clearAll();
  messages = new Map();
  fetched = [];
  raws = new Map();
  store = createMemoryFileStore();
  bind();
});

describeDb("raw mail capture", () => {
  it("stores the whole message and its row, then processes it from that copy", async () => {
    send("m1");
    expect(await readMailbox()).toMatchObject({ status: "ok", captured: 1, messages: 1, receipts: 1 });
    const row = await db.receiptMailMessage.findFirstOrThrow();
    const raw = raws.get("m1")!;
    expect(row).toMatchObject({
      orgId: TEST_ORG_ID,
      gmailMessageId: "m1",
      rawSha256: createHash("sha256").update(raw).digest("hex"),
      rawSize: raw.length,
      processedAt: expect.any(Date),
      processError: null,
    });
    expect(row.rawKey).toMatch(/^mail-raw\/[0-9a-f-]{36}$/);
    expect(Buffer.from(store.objects.get(row.rawKey)!)).toEqual(raw);
    expect(row.receivedAt.getTime()).toBe(Number(messages.get("m1")!.internalDate));
  });

  it("writes nothing more, and fetches nothing, on a second run", async () => {
    send("m1");
    await readMailbox();
    const before = await made();
    fetched.length = 0;
    expect(await readMailbox()).toMatchObject({ captured: 0, messages: 0, receipts: 0 });
    expect(fetched).toEqual([]);
    expect(await made()).toEqual(before);
    expect(await db.receiptMailMessage.count()).toBe(1);
  });

  it("keeps one row when another run captures the same message first", async () => {
    send("m1");
    const { getRaw } = reader;
    reader.getRaw = async (id) => {
      const answer = await getRaw(id);
      await db.receiptMailMessage.create({ data: { orgId: TEST_ORG_ID, gmailMessageId: id, receivedAt: new Date(), rawKey: "mail-raw/other", rawSha256: "x", rawSize: 1 } });
      store.objects.set("mail-raw/other", answer.raw);
      return answer;
    };
    try {
      expect(await readMailbox()).toMatchObject({ status: "ok", failed: 0, receipts: 1 });
    } finally {
      reader.getRaw = getRaw;
    }
    expect(await db.receiptMailMessage.count()).toBe(1);
  });

  it("does not capture a message the ledger shows finished from before capture", async () => {
    send("old");
    await db.receiptMailItem.create({
      data: { orgId: TEST_ORG_ID, gmailMessageId: "old", attachmentHash: "h", receivedAt: new Date(), senderAddress: "alice@example.org", status: "assigned" },
    });
    expect(await readMailbox()).toMatchObject({ captured: 0, skipped: 1 });
    expect(fetched).toEqual([]);
    expect(await db.receiptMailMessage.count()).toBe(0);
  });

  it("captures a message left unfinished from before capture, and takes only its files not yet in the ledger", async () => {
    send("half", ["a", "b"]);
    const hashA = createHash("sha256").update(pdf("a")).digest("hex");
    await db.receiptMailItem.create({
      data: { orgId: TEST_ORG_ID, gmailMessageId: "half", attachmentHash: hashA, receivedAt: new Date(), senderAddress: "alice@example.org", status: "assigned" },
    });
    await db.receiptMailAtRisk.create({ data: { orgId: TEST_ORG_ID, gmailMessageId: "half", receivedAt: new Date() } });
    expect(await readMailbox()).toMatchObject({ captured: 1, receipts: 1, skipped: 1 });
    expect(await db.receiptMailAtRisk.count()).toBe(0);
  });
});

describeDb("replaying a captured message", () => {
  const captured = () => db.receiptMailMessage.findFirstOrThrow();

  it("changes nothing for a message already processed", async () => {
    send("m1", ["a", "b"]);
    await readMailbox();
    const before = await made();
    const { id, processedAt } = await captured();
    expect(await processCapturedMessage(id)).toEqual({ status: "processed" });
    expect(await made()).toEqual(before);
    expect((await captured()).processedAt).toEqual(processedAt);
  });

  it("after a failure between two files, makes only the missing one", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    send("m1", ["a", "b"]);
    let receiptPuts = 0;
    bind({
      fileStore: {
        ...store,
        put: async (key, bytes, sha) => {
          if (key.startsWith("receipts/") && ++receiptPuts === 2) throw new KindedError("system", "store down");
          return store.put(key, bytes, sha);
        },
      },
    });
    expect(await readMailbox()).toMatchObject({ receipts: 1, failed: 1 });
    expect(await captured()).toMatchObject({ processedAt: null, processError: "system: store down" });

    bind();
    expect(await processCapturedMessage((await captured()).id)).toEqual({ status: "processed" });
    expect(await db.receipt.count()).toBe(2);
    expect(await db.receiptMailItem.count()).toBe(2);
    expect(await db.receiptMailReply.count()).toBe(1);
    expect(await captured()).toMatchObject({ processedAt: expect.any(Date), processError: null });
  });

  it.each([
    ["dev and staging", 30],
    ["prod", 90],
  ])("in %s, answers that the stored copy expired once it is %i days old, without asking the store", async (_env, days) => {
    bind({ rawMailRetentionDays: days });
    send("m1");
    await readMailbox();
    const { id } = await captured();
    const get = vi.spyOn(store, "get");

    await db.receiptMailMessage.update({ where: { id }, data: { capturedAt: new Date(Date.now() - (days - 1) * DAY_MS) } });
    expect(await processCapturedMessage(id)).toEqual({ status: "processed" });
    expect(get).toHaveBeenCalledOnce();

    get.mockClear();
    await db.receiptMailMessage.update({ where: { id }, data: { capturedAt: new Date(Date.now() - days * DAY_MS) } });
    expect(await processCapturedMessage(id)).toEqual({ status: "expired", message: `This email's stored copy expired ${days} days after capture.` });
    expect(get).not.toHaveBeenCalled();
  });

  it("answers expired in dev for a copy prod would still keep", async () => {
    send("m1");
    await readMailbox();
    const { id } = await captured();
    await db.receiptMailMessage.update({ where: { id }, data: { capturedAt: new Date(Date.now() - 45 * DAY_MS) } });
    expect(await processCapturedMessage(id)).toMatchObject({ status: "expired" });
    bind({ rawMailRetentionDays: 90 });
    expect(await processCapturedMessage(id)).toEqual({ status: "processed" });
  });

  it("fails, and records why, when the copy is missing inside the retention window", async () => {
    send("m1");
    await readMailbox();
    const row = await captured();
    store.objects.delete(row.rawKey);
    await expect(processCapturedMessage(row.id)).rejects.toMatchObject({ kind: "system", message: "This email's stored copy is missing" });
    expect(await captured()).toMatchObject({ processError: "system: This email's stored copy is missing" });
  });

  it("leaves a captured message past retention alone in the daily run", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    bind({ people: { submitterByEmail: async () => { throw new Error("people lookup down"); } } });
    send("m1");
    await readMailbox();
    const { id } = await captured();
    await db.receiptMailMessage.update({ where: { id }, data: { capturedAt: new Date(Date.now() - 31 * DAY_MS) } });
    bind();
    const get = vi.spyOn(store, "get");
    expect(await readMailbox()).toMatchObject({ messages: 0, failed: 0 });
    expect(get).not.toHaveBeenCalled();
  });

  it("refuses an unknown message, and one from another org", async () => {
    await expect(processCapturedMessage(12345)).rejects.toMatchObject({ status: 404 });
    const other = await db.receiptMailMessage.create({
      data: { orgId: "00000000-0000-0000-0000-000000000002", gmailMessageId: "x", receivedAt: new Date(), rawKey: "mail-raw/x", rawSha256: "x", rawSize: 1 },
    });
    await expect(processCapturedMessage(other.id)).rejects.toMatchObject({ status: 404 });
  });
});

describeDb("replay from the mail page", () => {
  it("audits who asked, and answers the outcome alone", async () => {
    send("m1");
    await readMailbox();
    const { id } = await db.receiptMailMessage.findFirstOrThrow();
    actAs(FINANCE);
    expect(await mailQueueService.replay(id)).toEqual({ status: "processed" });
    expect(await db.receiptAuditLog.findFirst({ where: { action: "mail_replayed" } })).toMatchObject({
      receiptId: null,
      userId: FINANCE.id,
      username: FINANCE.name,
      fieldChanged: "mail_message",
      valueBefore: String(id),
    });
  });
});

describeDb("a captured email stuck on the Problems list", () => {
  const BY = { userId: FINANCE.id, username: FINANCE.name };

  /** Captures m1 with its processing failing, then dates its capture `ageMs` ago. */
  async function stuckMessage(ageMs = WAITING_NOTICE_MS + 60_000) {
    vi.spyOn(console, "error").mockImplementation(() => {});
    bind({ people: { submitterByEmail: async () => { throw new Error("people lookup down"); } } });
    send("m1");
    await readMailbox();
    const capturedAt = new Date(Date.now() - ageMs);
    const { id } = await db.receiptMailMessage.findFirstOrThrow({ where: { gmailMessageId: "m1" } });
    const row = await db.receiptMailMessage.update({ where: { id }, data: { capturedAt }, select: { id: true, processedAt: true } });
    expect(row.processedAt).toBeNull();
    return { id: row.id, capturedAt };
  }

  it("lists an email unprocessed 25 hours after capture, timed from capture", async () => {
    const { id, capturedAt } = await stuckMessage();
    expect(await stuckItems()).toEqual([{ id: String(id), step: "mail message", href: "/receipts/mail", failedAt: capturedAt }]);
  });

  it("leaves out one captured within 25 hours and one processed", async () => {
    const { id } = await stuckMessage(WAITING_NOTICE_MS - 60_000);
    expect(await stuckItems()).toEqual([]);
    await db.receiptMailMessage.update({ where: { id }, data: { capturedAt: new Date(Date.now() - 2 * DAY_MS), processedAt: new Date() } });
    expect(await stuckItems()).toEqual([]);
  });

  it("keeps listing one whose stored copy has expired, marked expired", async () => {
    const { id, capturedAt } = await stuckMessage(31 * DAY_MS);
    expect(await stuckItems()).toEqual([{ id: String(id), step: "mail message", href: "/receipts/mail", failedAt: capturedAt, expired: true }]);
  });

  it("answers Retry on an expired one 409 with the expiry message, and keeps it listed", async () => {
    const { id } = await stuckMessage(31 * DAY_MS);
    bind();
    await expect(retryStuckItem({ id: String(id), step: "mail message" }, BY)).rejects.toMatchObject({
      status: 409,
      message: "This email's stored copy expired 30 days after capture.",
    });
    expect(await db.receiptMailMessage.findUniqueOrThrow({ where: { id } })).toMatchObject({ processedAt: null });
    expect(await stuckItems()).toEqual([expect.objectContaining({ id: String(id), expired: true })]);
  });

  it("Retry replays it from the stored copy, audited with who pressed it, and it leaves the list", async () => {
    const { id } = await stuckMessage();
    bind();
    await retryStuckItem({ id: String(id), step: "mail message" }, BY);
    expect(await db.receiptMailMessage.findUniqueOrThrow({ where: { id } })).toMatchObject({ processedAt: expect.any(Date), processError: null });
    expect(await db.receipt.count()).toBe(1);
    expect(await db.receiptAuditLog.findFirst({ where: { action: "mail_replayed" } })).toMatchObject({ userId: FINANCE.id, valueBefore: String(id) });
    expect(await stuckItems()).toEqual([]);
    await expect(retryStuckItem({ id: String(id), step: "mail message" }, BY)).rejects.toMatchObject({ status: 404 });
  });

  it("answers 409, with no error text, when the replay fails again", async () => {
    const { id } = await stuckMessage();
    await expect(retryStuckItem({ id: String(id), step: "mail message" }, BY)).rejects.toMatchObject({ status: 409, message: MAIL_STILL_STUCK });
    expect(await stuckItems()).toEqual([expect.objectContaining({ id: String(id), step: "mail message" })]);
  });

  it("answers 404 for an id that is not a stuck captured email", async () => {
    await expect(retryStuckItem({ id: "not-a-number", step: "mail message" }, BY)).rejects.toMatchObject({ status: 404 });
    await expect(retryStuckItem({ id: "12345", step: "mail message" }, BY)).rejects.toMatchObject({ status: 404 });
  });
});

describeDb("the mail page's list of captured emails not yet processed", () => {
  /** Captures each id unprocessed, then dates its capture `ageMs` ago. */
  async function captured(id: string, ageMs: number) {
    const row = await db.receiptMailMessage.create({
      data: { orgId: TEST_ORG_ID, gmailMessageId: id, receivedAt: new Date(Date.now() - ageMs - 60_000), capturedAt: new Date(Date.now() - ageMs), rawKey: `mail-raw/${id}`, rawSha256: "x", rawSize: 1 },
    });
    return { id: row.id, receivedAt: row.receivedAt, capturedAt: row.capturedAt };
  }

  it("lists every unprocessed email oldest capture first, flagging those past retention, with no key or error", async () => {
    bind({ rawMailRetentionDays: 30 });
    const fresh = await captured("fresh", 60_000);
    const old = await captured("old", 31 * DAY_MS);
    const stuck = await captured("stuck", 2 * DAY_MS);
    await db.receiptMailMessage.update({ where: { id: stuck.id }, data: { processError: "system: people lookup down" } });
    expect(await mailQueueService.listUnprocessed()).toEqual([
      { ...old, expired: true },
      { ...stuck, expired: false },
      { ...fresh, expired: false },
    ]);
  });

  it("leaves out processed emails and other orgs' emails", async () => {
    const done = await captured("done", 60_000);
    await db.receiptMailMessage.update({ where: { id: done.id }, data: { processedAt: new Date() } });
    await db.receiptMailMessage.create({
      data: { orgId: "00000000-0000-0000-0000-000000000002", gmailMessageId: "theirs", receivedAt: new Date(), rawKey: "mail-raw/theirs", rawSha256: "x", rawSize: 1 },
    });
    expect(await mailQueueService.listUnprocessed()).toEqual([]);
  });
});
