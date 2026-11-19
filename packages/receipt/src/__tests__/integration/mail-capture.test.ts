import { createHash } from "node:crypto";
import { KindedError } from "@checkin/component-kit";
import { beforeEach, expect, it, vi } from "vitest";
import { db } from "../../db";
import type { MailboxReader, MailMessage } from "../../contract";
import { createMemoryFileStore } from "../../lib/fileStorage";
import { processCapturedMessage, readMailbox } from "../../services/mailIntake";
import { describeDb } from "../helpers/db";
import { toRaw } from "../helpers/mime";
import { ALICE, clearAll, configure, okOcr, TEST_ORG_ID } from "../helpers/setup";

const GOOGLE_PASS = "mx.google.com; dkim=pass header.i=@example.org; spf=pass; dmarc=pass header.from=example.org";
const DAY_MS = 24 * 60 * 60_000;
const pdf = (label: string) => `%PDF-1.4 receipt ${label}`;
const b64 = (s: string) => Buffer.from(s).toString("base64url");

let messages: Map<string, MailMessage>;
let fetched: string[];
let store: ReturnType<typeof createMemoryFileStore>;

const reader: MailboxReader = {
  address: "receipts@example.org",
  listRecent: async () => [...messages.keys()],
  getRaw: async (id) => {
    fetched.push(id);
    const msg = messages.get(id);
    if (!msg) throw new Error(`no message ${id}`);
    return { raw: toRaw(msg), internalDate: msg.internalDate };
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
  store = createMemoryFileStore();
  bind();
});

describeDb("raw mail capture", () => {
  it("stores the whole message and its row, then processes it from that copy", async () => {
    send("m1");
    expect(await readMailbox()).toMatchObject({ status: "ok", captured: 1, messages: 1, receipts: 1 });
    const row = await db.receiptMailMessage.findFirstOrThrow();
    const raw = toRaw(messages.get("m1")!);
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
