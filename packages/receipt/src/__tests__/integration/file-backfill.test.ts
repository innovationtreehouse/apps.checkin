import { beforeEach, expect, it } from "vitest";
import { db } from "../../db";
import { createMemoryFileStore, sha256Hex } from "../../lib/fileStorage";
import { backfillFiles, verifyFiles } from "../../services/fileBackfill";
import { describeDb } from "../helpers/db";
import { clearAll, TEST_ORG_ID, textFile } from "../helpers/setup";

let store: ReturnType<typeof createMemoryFileStore>;
let seq = 0;

async function receiptWithBytes(bytes = textFile(), fileHash = sha256Hex(bytes)): Promise<string> {
  const id = `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
  await db.receipt.create({ data: { id, orgId: TEST_ORG_ID, uploadedByUserId: 1, fileBlob: new Uint8Array(bytes), fileHash, mimeType: "text/plain" } });
  return id;
}

async function mailItemWithBytes(bytes = textFile(), attachmentHash = sha256Hex(bytes)): Promise<number> {
  const { id } = await db.receiptMailItem.create({
    data: { orgId: TEST_ORG_ID, gmailMessageId: `m${++seq}`, attachmentHash, receivedAt: new Date(), senderAddress: "stranger@elsewhere.test", status: "held", fileBlob: new Uint8Array(bytes), mimeType: "text/plain" },
  });
  return id;
}

const receiptRow = (id: string) => db.receipt.findUniqueOrThrow({ where: { id } });
const mailRow = (id: number) => db.receiptMailItem.findUniqueOrThrow({ where: { id } });

beforeEach(async () => {
  await clearAll();
  store = createMemoryFileStore();
});

describeDb("receipt file backfill", () => {
  it("copies every row with bytes, sets its key and size, and leaves the bytes in place", async () => {
    const receiptFile = textFile();
    const mailFile = textFile();
    const receipt = await receiptWithBytes(receiptFile);
    const item = await mailItemWithBytes(mailFile);

    const report = await backfillFiles(store);

    expect(report).toEqual({ copied: 2, alreadyStored: 0, gone: 0, mismatches: [], failures: [] });
    const r = await receiptRow(receipt);
    expect(r).toMatchObject({ fileKey: `receipts/${receipt}`, fileSize: receiptFile.length });
    expect(Buffer.from(r.fileBlob ?? []).equals(receiptFile)).toBe(true);
    expect(Buffer.from(store.objects.get(`receipts/${receipt}`) ?? []).equals(receiptFile)).toBe(true);
    const m = await mailRow(item);
    expect(m.fileKey).toMatch(/^mail-items\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(m.fileSize).toBe(mailFile.length);
    expect(Buffer.from(m.fileBlob ?? []).equals(mailFile)).toBe(true);
    expect(Buffer.from(store.objects.get(m.fileKey ?? "") ?? []).equals(mailFile)).toBe(true);
  });

  it("copies more rows than one batch", async () => {
    for (let i = 0; i < 52; i++) await receiptWithBytes();
    expect((await backfillFiles(store)).copied).toBe(52);
    expect(await db.receipt.count({ where: { fileKey: null } })).toBe(0);
  });

  it("a second run changes nothing", async () => {
    await receiptWithBytes();
    await mailItemWithBytes();
    await backfillFiles(store);
    expect(await backfillFiles(store)).toEqual({ copied: 0, alreadyStored: 0, gone: 0, mismatches: [], failures: [] });
  });

  it("resumes after a crash between the put and the update, for both tables", async () => {
    const receipt = await receiptWithBytes();
    const item = await mailItemWithBytes();
    await backfillFiles(store);
    const { fileKey: mailKey } = await mailRow(item);
    await db.receipt.update({ where: { id: receipt }, data: { fileKey: null } });
    await db.receiptMailItem.update({ where: { id: item }, data: { fileKey: null } });

    const report = await backfillFiles(store);

    expect(report).toMatchObject({ copied: 0, alreadyStored: 2, mismatches: [], failures: [] });
    expect((await receiptRow(receipt)).fileKey).toBe(`receipts/${receipt}`);
    expect((await mailRow(item)).fileKey).toBe(mailKey);
    expect(store.objects.size).toBe(2);
  });

  it("reports an object with other bytes, and neither overwrites it nor sets the key", async () => {
    const receipt = await receiptWithBytes();
    const other = textFile();
    await store.put(`receipts/${receipt}`, other, sha256Hex(other));

    const report = await backfillFiles(store);

    expect(report.mismatches).toEqual([`receipt ${receipt}`]);
    expect((await receiptRow(receipt)).fileKey).toBeNull();
    expect(Buffer.from(store.objects.get(`receipts/${receipt}`) ?? []).equals(other)).toBe(true);
  });

  it("reports bytes that do not match the stored hash, and copies nothing for that row", async () => {
    const receipt = await receiptWithBytes(textFile(), "0".repeat(64));
    const report = await backfillFiles(store);
    expect(report.mismatches).toEqual([`receipt ${receipt}`]);
    expect(store.objects.size).toBe(0);
    expect((await receiptRow(receipt)).fileKey).toBeNull();
  });

  it("a store failure on one row is reported and the other rows still copy", async () => {
    const bad = await receiptWithBytes();
    const good = await receiptWithBytes();
    const flaky = {
      ...store,
      put: async (key: string, bytes: Uint8Array, sha256: string) => {
        if (key === `receipts/${bad}`) throw Object.assign(new Error("s3 down"), { name: "SlowDown" });
        await store.put(key, bytes, sha256);
      },
    };

    const report = await backfillFiles(flaky);

    expect(report.failures).toEqual([`receipt ${bad}: SlowDown`]);
    expect((await receiptRow(bad)).fileKey).toBeNull();
    expect((await receiptRow(good)).fileKey).toBe(`receipts/${good}`);
  });

  it("gives no key to a mail item that lost its bytes while it copied", async () => {
    const item = await mailItemWithBytes();
    const racing = {
      ...store,
      put: async (key: string, bytes: Uint8Array, sha256: string) => {
        await store.put(key, bytes, sha256);
        await db.receiptMailItem.update({ where: { id: item }, data: { status: "assigned", fileBlob: null } });
      },
    };

    const report = await backfillFiles(racing);

    expect(report).toMatchObject({ copied: 0, gone: 1 });
    expect((await mailRow(item)).fileKey).toBeNull();
  });

  it("skips rows that already have a key or hold no bytes", async () => {
    const stored = textFile();
    await db.receipt.create({ data: { id: "00000000-0000-4000-8000-000000000000", orgId: TEST_ORG_ID, uploadedByUserId: 1, fileKey: "receipts/x", fileHash: sha256Hex(stored), mimeType: "text/plain" } });
    await db.receiptMailItem.create({ data: { orgId: TEST_ORG_ID, gmailMessageId: "gone", attachmentHash: "h", receivedAt: new Date(), senderAddress: "a@b.test", status: "assigned" } });
    expect(await backfillFiles(store)).toEqual({ copied: 0, alreadyStored: 0, gone: 0, mismatches: [], failures: [] });
    expect(store.objects.size).toBe(0);
  });
});

describeDb("receipt file verify", () => {
  it("is clean once every row with bytes has a matching object", async () => {
    await receiptWithBytes();
    await mailItemWithBytes();
    await backfillFiles(store);
    expect(await verifyFiles(store)).toEqual({ matched: 2, noKey: [], missing: [], mismatches: [], failures: [] });
  });

  it("reports rows with bytes and no key, and writes nothing", async () => {
    const receipt = await receiptWithBytes();
    const item = await mailItemWithBytes();
    const report = await verifyFiles(store);
    expect(report.noKey.sort()).toEqual([`mail item ${item}`, `receipt ${receipt}`].sort());
    expect(store.objects.size).toBe(0);
    expect((await receiptRow(receipt)).fileKey).toBeNull();
  });

  it("reports a missing object, a changed object and a wrong stored hash, and fixes none of them", async () => {
    const gone = await receiptWithBytes();
    const changed = await receiptWithBytes();
    const wrongHash = await mailItemWithBytes();
    await backfillFiles(store);
    store.objects.delete(`receipts/${gone}`);
    const changedBytes = new TextEncoder().encode("other bytes");
    store.objects.set(`receipts/${changed}`, changedBytes);
    await db.receiptMailItem.update({ where: { id: wrongHash }, data: { attachmentHash: "0".repeat(64) } });

    const report = await verifyFiles(store);

    expect(report.missing).toEqual([`receipt ${gone}`]);
    expect(report.mismatches.sort()).toEqual([`mail item ${wrongHash}`, `receipt ${changed}`].sort());
    expect(report.matched).toBe(0);
    expect(store.objects.has(`receipts/${gone}`)).toBe(false);
    expect(store.objects.get(`receipts/${changed}`)).toEqual(changedBytes);
    expect((await receiptRow(gone)).fileKey).toBe(`receipts/${gone}`);
  });

  it("reports a read failure", async () => {
    const receipt = await receiptWithBytes();
    await backfillFiles(store);
    const failing = { ...store, get: async () => { throw Object.assign(new Error("denied"), { name: "AccessDenied" }); } };
    expect((await verifyFiles(failing)).failures).toEqual([`receipt ${receipt}: AccessDenied`]);
  });
});
