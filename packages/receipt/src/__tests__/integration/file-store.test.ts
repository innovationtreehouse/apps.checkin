import { beforeEach, expect, it } from "vitest";
import { db } from "../../db";
import { createMemoryFileStore, sha256Hex } from "../../lib/fileStorage";
import { insertReceipt } from "../../lib/insert";
import type { ReceiptLimits } from "../../lib/limits";
import { mailQueueService } from "../../services/mailQueueService";
import { receiptService } from "../../services/receiptService";
import { describeDb } from "../helpers/db";
import { actAs, ALICE, clearAll, configure, FINANCE, manualDetails, okOcr, stateOf, TEST_ORG_ID, textFile } from "../helpers/setup";

let store: ReturnType<typeof createMemoryFileStore>;
let seq = 0;

function configureStore(flag: boolean, limits: Partial<ReceiptLimits> = {}): void {
  store = createMemoryFileStore();
  configure({
    ocr: okOcr(),
    limits,
    fileStore: store,
    storeNewFilesInBucket: flag,
    people: { submitterByEmail: async (address) => (address === "alice@example.org" ? ALICE : null) },
  });
}

/** A held item whose file is in the store. */
async function heldInStore(bytes = textFile(), attachmentHash = sha256Hex(bytes)): Promise<{ id: number; key: string }> {
  const key = `mail-items/test-${++seq}`;
  await store.put(key, bytes, sha256Hex(bytes));
  const { id } = await db.receiptMailItem.create({
    data: { orgId: TEST_ORG_ID, gmailMessageId: `m${seq}`, attachmentHash, receivedAt: new Date(), senderAddress: "stranger@elsewhere.test", status: "held", fileKey: key, fileSize: bytes.length, mimeType: "text/plain" },
  });
  return { id, key };
}

beforeEach(async () => {
  await clearAll();
  configureStore(true);
});

describeDb("receipt file store", () => {
  it("flag off: the bytes stay in the row and the store is untouched", async () => {
    configureStore(false);
    const file = textFile();
    const r = await receiptService.upload(file, "text/plain", { details: manualDetails() });
    const row = await db.receipt.findUniqueOrThrow({ where: { id: r.id } });
    expect(row).toMatchObject({ fileKey: null, fileSize: file.length });
    expect(Buffer.from(row.fileBlob ?? []).equals(file)).toBe(true);
    expect(store.objects.size).toBe(0);
  });

  it("flag on: the object is stored, the row has no bytes, and the file route reads it back", async () => {
    const file = textFile();
    const r = await receiptService.upload(file, "text/plain", { details: manualDetails() });
    const row = await db.receipt.findUniqueOrThrow({ where: { id: r.id } });
    expect(row).toMatchObject({ fileBlob: null, fileKey: `receipts/${r.id}`, fileSize: file.length });
    expect(r).not.toHaveProperty("fileKey");
    expect(r).not.toHaveProperty("fileSize");
    const served = await receiptService.getFile(r.id, "submitter");
    expect(Buffer.from(served.fileBlob).equals(file)).toBe(true);
  });

  it("a row with bytes and no key still serves, with the flag on", async () => {
    configureStore(false);
    const file = textFile();
    const r = await receiptService.upload(file, "text/plain", { details: manualDetails() });
    configureStore(true);
    expect(Buffer.from((await receiptService.getFile(r.id, "submitter")).fileBlob).equals(file)).toBe(true);
  });

  it("a missing object answers 404 on the file route", async () => {
    const r = await receiptService.upload(textFile(), "text/plain", { details: manualDetails() });
    store.objects.clear();
    await expect(receiptService.getFile(r.id, "submitter")).rejects.toMatchObject({ status: 404 });
  });

  it("OCR reads from the store, and a missing object lands in ocr_failed", async () => {
    const extracted: string[] = [];
    const ocr = okOcr();
    const spy = { extract: (f: Buffer, m: string) => (extracted.push(f.toString()), ocr.extract(f, m)) };
    configure({ ocr: spy, fileStore: store, storeNewFilesInBucket: true });
    const file = textFile();
    await receiptService.upload(file, "text/plain", {});
    expect(extracted).toEqual([file.toString()]);

    const failing = createMemoryFileStore();
    configure({ ocr, storeNewFilesInBucket: true, fileStore: { ...failing, put: async () => {}, get: async () => null } });
    const r = await receiptService.upload(textFile(), "text/plain", {});
    expect(await stateOf(r.id)).toBe("ocr_failed");
  });

  it("a failed insert takes its object back", async () => {
    await expect(
      insertReceipt({
        orgId: TEST_ORG_ID,
        actor: ALICE,
        file: textFile(),
        mimeType: "text/plain",
        detail: { state: "uploaded" },
        lines: [],
        auditAction: "uploaded",
        afterInsert: async () => {
          expect(store.objects.size).toBe(1);
          throw new Error("insert failed");
        },
      }),
    ).rejects.toThrow("insert failed");
    expect(store.objects.size).toBe(0);
    expect(await db.receipt.count()).toBe(0);
  });

  it("a refused upload stores nothing, and the byte limit counts file_size", async () => {
    const file = textFile();
    configureStore(true, { uploadBytesPerPersonPerDay: file.length + 5 });
    await receiptService.upload(file, "text/plain", { details: manualDetails() });
    await expect(receiptService.upload(textFile("x".repeat(20)), "text/plain", { details: manualDetails() })).rejects.toMatchObject({ status: 429 });
    expect(store.objects.size).toBe(1);
  });

  it("assigning a held item moves its file and deletes the mail object", async () => {
    const file = textFile();
    const { id, key } = await heldInStore(file);
    actAs(FINANCE);
    const shown = await mailQueueService.assign(id, { email: "alice@example.org" });
    expect(shown).not.toHaveProperty("fileKey");
    expect(store.objects.has(key)).toBe(false);
    expect(await db.receiptMailItem.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "assigned", fileKey: null, fileBlob: null });
    expect(Buffer.from(store.objects.get(`receipts/${shown.receiptId}`) ?? []).equals(file)).toBe(true);
  });

  it("the mail queue serves a stored item, and 404s when its object is gone", async () => {
    const file = textFile();
    const { id, key } = await heldInStore(file);
    actAs(FINANCE);
    expect(Buffer.from((await mailQueueService.getFile(id)).fileBlob).equals(file)).toBe(true);
    store.objects.delete(key);
    await expect(mailQueueService.getFile(id)).rejects.toMatchObject({ status: 404 });
  });

  it("discarding deletes the object of the item and its copies, and each row keeps its key", async () => {
    const file = textFile();
    const hash = sha256Hex(file);
    const first = await heldInStore(file, hash);
    const copy = await heldInStore(file, hash);
    actAs(FINANCE);
    const shown = await mailQueueService.discard(first.id, { reason: "spam", ignoreFile: true });
    expect(shown).not.toHaveProperty("fileKey");
    expect(store.objects.size).toBe(0);
    expect(await db.receiptMailItem.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({ status: "discarded", fileKey: first.key });
    expect(await db.receiptMailItem.findUniqueOrThrow({ where: { id: copy.id } })).toMatchObject({ status: "discarded", fileKey: copy.key });
    await expect(mailQueueService.getFile(first.id)).rejects.toMatchObject({ status: 404 });
  });

  it("a store that fails on delete does not fail the discard", async () => {
    const { id } = await heldInStore();
    configure({ fileStore: { ...store, delete: async () => { throw new Error("s3 down"); } }, storeNewFilesInBucket: true });
    actAs(FINANCE);
    await expect(mailQueueService.discard(id, { reason: "spam" })).resolves.toMatchObject({ status: "discarded" });
  });
});
