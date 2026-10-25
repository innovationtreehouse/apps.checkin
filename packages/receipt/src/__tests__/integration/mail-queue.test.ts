import { beforeEach, expect, it } from "vitest";
import { db } from "../../db";
import { CANNOT_ASSIGN, mailQueueService } from "../../services/mailQueueService";
import { intakeMailedReceipt, receiptService } from "../../services/receiptService";
import type { ReceiptLimits } from "../../lib/limits";
import { describeDb } from "../helpers/db";
import { actAs, ALICE, BOB, clearAll, configure, FINANCE, okOcr, stateOf, TEST_ORG_ID, textFile } from "../helpers/setup";

const PEOPLE: Record<string, typeof ALICE> = { "alice@example.org": ALICE, "bob@example.org": BOB, "finn@example.org": FINANCE };

let seq = 0;
async function holdItem(status = "held", senderAddress = "stranger@elsewhere.test", attachmentHash?: string): Promise<number> {
  const n = ++seq;
  const item = await db.receiptMailItem.create({
    data: {
      orgId: TEST_ORG_ID,
      gmailMessageId: `m${n}`,
      attachmentHash: attachmentHash ?? `h${n}`,
      receivedAt: new Date(),
      senderAddress,
      status,
      fileBlob: new Uint8Array(Buffer.from(`%PDF-1.4 held ${n} ${Date.now()}`)),
      mimeType: "application/pdf",
    },
  });
  return item.id;
}

function configureQueue(limits: Partial<ReceiptLimits> = {}): void {
  configure({
    ocr: okOcr(),
    limits,
    people: { submitterByEmail: async (address) => PEOPLE[address] ?? null },
    // Bob shares Finn's household.
    households: { householdOf: async (ids) => (ids.includes(FINANCE.id) ? [FINANCE.id, BOB.id] : []) },
  });
  actAs(FINANCE);
}

beforeEach(async () => {
  await clearAll();
  configureQueue();
});

describeDb("finance mail queue", () => {
  it("lists held items without their file, and audits each one shown", async () => {
    const id = await holdItem();
    const [shown] = await mailQueueService.listHeld();
    expect(shown).toMatchObject({ id, senderAddress: "stranger@elsewhere.test", mimeType: "application/pdf" });
    expect(shown).not.toHaveProperty("fileBlob");
    const rows = await db.receiptAuditLog.findMany({ where: { action: "mail_item_viewed" } });
    expect(rows).toEqual([expect.objectContaining({ receiptId: null, userId: FINANCE.id, valueBefore: String(id) })]);
  });

  it("assigns a held item as exactly one emailed receipt uploaded by the assignee", async () => {
    const id = await holdItem();
    const out = await mailQueueService.assign(id, { email: "Alice@Example.org" });

    const receipts = await db.receipt.findMany();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ uploadedByUserId: ALICE.id, intakeSource: "email" });
    expect(await stateOf(receipts[0].id)).toBe("submitter_review");
    expect(out).toMatchObject({ id, status: "assigned", receiptId: receipts[0].id });
    expect(await db.receiptMailItem.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "assigned", fileBlob: null });
    expect(await db.receiptAuditLog.count({ where: { receiptId: receipts[0].id, action: "mail_assigned", userId: FINANCE.id } })).toBe(1);

    await expect(mailQueueService.assign(id, { email: "alice@example.org" })).rejects.toMatchObject({ status: 404 });
    expect(await db.receipt.count()).toBe(1);
  });

  it("creates one receipt when two assigns race", async () => {
    const id = await holdItem();
    const results = await Promise.allSettled([
      mailQueueService.assign(id, { email: "alice@example.org" }),
      mailQueueService.assign(id, { email: "alice@example.org" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.receipt.count()).toBe(1);
  });

  it.each([
    ["themself", "finn@example.org"],
    ["their own household", "bob@example.org"],
  ])("refuses a finance holder assigning to %s, and audits the attempt", async (_who, email) => {
    const id = await holdItem();
    await expect(mailQueueService.assign(id, { email })).rejects.toMatchObject({ status: 403 });
    expect(await db.receipt.count()).toBe(0);
    expect(await db.receiptMailItem.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "held" });
    expect(await db.receiptAuditLog.count({ where: { action: "mail_assign_refused", valueBefore: String(id) } })).toBe(1);
  });

  it("answers one status and message for every email it cannot assign to", async () => {
    const id = await holdItem();
    // The host port answers null alike for no one, several people, unverified sign-in and a failed submitter gate.
    for (const email of ["nobody@example.org", "unverified@example.org"]) {
      await expect(mailQueueService.assign(id, { email })).rejects.toMatchObject({ status: 404, message: CANNOT_ASSIGN });
    }
    await expect(mailQueueService.assign(id, {})).rejects.toMatchObject({ status: 400 });
    expect(await db.receipt.count()).toBe(0);
  });

  it("discards only with a reason, clears the file and audits the reason", async () => {
    const id = await holdItem();
    for (const body of [{}, { reason: "   " }]) {
      await expect(mailQueueService.discard(id, body)).rejects.toMatchObject({ status: 400 });
    }
    expect(await mailQueueService.discard(id, { reason: "newsletter" })).toMatchObject({ id, status: "discarded" });
    expect(await db.receiptMailItem.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "discarded", fileBlob: null });
    expect(await db.receiptAuditLog.findFirst({ where: { action: "mail_discarded" } })).toMatchObject({
      receiptId: null,
      userId: FINANCE.id,
      valueBefore: String(id),
      valueAfter: "newsletter",
    });
    await expect(mailQueueService.discard(id, { reason: "again" })).rejects.toMatchObject({ status: 404 });
    await expect(mailQueueService.getFile(id)).rejects.toMatchObject({ status: 404 });
  });

  it("serves a held file and audits the read", async () => {
    const id = await holdItem();
    expect(await mailQueueService.getFile(id)).toMatchObject({ id, mimeType: "application/pdf" });
    expect(await db.receiptAuditLog.count({ where: { action: "mail_file_viewed", valueBefore: String(id) } })).toBe(1);
  });

  it("lists deferred items beside held ones", async () => {
    const held = await holdItem();
    const deferred = await holdItem("deferred", "alice@example.org");
    expect((await mailQueueService.listHeld()).map((i) => [i.id, i.status])).toEqual([
      [held, "held"],
      [deferred, "deferred"],
    ]);
  });

  it("releases a deferred item as its sender, outside their daily upload limit, and audits who released it", async () => {
    configureQueue({ uploadsPerPersonPerDay: 0 });
    const id = await holdItem("deferred", "alice@example.org");
    await expect(mailQueueService.assign(id, { email: "alice@example.org" })).rejects.toMatchObject({ status: 429 });

    const out = await mailQueueService.assign(id, { release: true });
    const [receipt] = await db.receipt.findMany();
    expect(receipt).toMatchObject({ uploadedByUserId: ALICE.id, intakeSource: "email" });
    expect(out).toMatchObject({ id, status: "assigned", receiptId: receipt.id });
    expect(await db.receiptMailItem.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "assigned", fileBlob: null });
    expect(await db.receiptAuditLog.count({ where: { receiptId: receipt.id, action: "mail_released", userId: FINANCE.id } })).toBe(1);
    await expect(mailQueueService.assign(id, { release: true })).rejects.toMatchObject({ status: 404 });
  });

  it("releases only a deferred item, and never to the releaser's own household", async () => {
    await expect(mailQueueService.assign(await holdItem(), { release: true })).rejects.toMatchObject({ status: 409 });
    const own = await holdItem("deferred", "bob@example.org");
    await expect(mailQueueService.assign(own, { release: true })).rejects.toMatchObject({ status: 403 });
    await expect(mailQueueService.assign(own, { release: false })).rejects.toMatchObject({ status: 400 });
    expect(await db.receipt.count()).toBe(0);
  });

  it("assigns past a member's mail limit, and leaves their own mail allowance untouched", async () => {
    for (let i = 0; i < 6; i++) {
      await expect(mailQueueService.assign(await holdItem(), { email: "alice@example.org" })).resolves.toMatchObject({ status: "assigned" });
    }
    await expect(intakeMailedReceipt(ALICE, Buffer.from(`%PDF-1.4 own ${Date.now()}`), "application/pdf", async () => {})).resolves.toEqual(expect.any(String));
    expect(await db.receipt.count({ where: { uploadedByUserId: ALICE.id } })).toBe(7);
  });
});

describeDb("mailbox ignore list", () => {
  const ignoreRows = () => db.receiptAuditLog.findMany({ where: { action: { in: ["file_ignored", "file_unignored"] } }, orderBy: { id: "asc" } });

  it("discards with ignoreFile, lists the file, and discards every stored copy in the same step", async () => {
    const id = await holdItem("held", "news@elsewhere.test", "logo");
    const copy = await holdItem("deferred", "alice@example.org", "logo");
    const other = await holdItem();
    const shown = await mailQueueService.discard(id, { reason: "newsletter logo", ignoreFile: true });
    expect(shown).toMatchObject({ id, status: "discarded" });
    expect(shown).not.toHaveProperty("attachmentHash");
    expect(await db.receiptMailItem.findUniqueOrThrow({ where: { id: copy } })).toMatchObject({ status: "discarded", fileBlob: null });
    expect(await db.receiptMailItem.findUniqueOrThrow({ where: { id: other } })).toMatchObject({ status: "held" });
    expect(await mailQueueService.listIgnored()).toEqual([
      expect.objectContaining({ orgId: TEST_ORG_ID, fileHash: "logo", reason: "newsletter logo", addedByUserId: FINANCE.id }),
    ]);
    const discards = await db.receiptAuditLog.findMany({ where: { action: "mail_discarded" } });
    expect(discards.map((r) => r.valueBefore).sort()).toEqual([String(id), String(copy)].sort());
    expect(await ignoreRows()).toEqual([
      expect.objectContaining({ receiptId: null, userId: FINANCE.id, fieldChanged: "mail_item", valueBefore: String(id), valueAfter: "newsletter logo" }),
    ]);
  });

  it("rejects an unknown discard field", async () => {
    const id = await holdItem();
    await expect(mailQueueService.discard(id, { reason: "x", ignoreFile: false })).rejects.toMatchObject({ status: 400 });
  });

  it("lists a discarded receipt's file, once, with no audit row on its receipt", async () => {
    const r = { id: await intakeMailedReceipt(ALICE, textFile(), "text/plain", async () => undefined) };
    await expect(mailQueueService.ignoreReceiptFile(r.id, { reason: "logo" })).rejects.toMatchObject({ status: 409 });
    actAs(ALICE);
    await receiptService.discard(r.id, "submitter");
    actAs(FINANCE);
    const entry = await mailQueueService.ignoreReceiptFile(r.id, { reason: "logo" });
    const { fileHash } = await db.receipt.findUniqueOrThrow({ where: { id: r.id } });
    expect(entry).toMatchObject({ fileHash, reason: "logo", addedByUserId: FINANCE.id });
    expect(await mailQueueService.ignoreReceiptFile(r.id, { reason: "again" })).toMatchObject({ id: entry.id, reason: "logo" });
    expect(await ignoreRows()).toEqual([expect.objectContaining({ receiptId: null, fieldChanged: "receipt", valueBefore: r.id, valueAfter: "logo" })]);
    await expect(mailQueueService.ignoreReceiptFile("no-such-receipt", { reason: "logo" })).rejects.toMatchObject({ status: 404 });
  });

  it("removes an entry, audited like an add", async () => {
    const id = await holdItem("held", "news@elsewhere.test", "logo");
    await mailQueueService.discard(id, { reason: "newsletter logo", ignoreFile: true });
    const [entry] = await mailQueueService.listIgnored();
    expect(await mailQueueService.removeIgnored(entry.id)).toMatchObject({ id: entry.id, fileHash: "logo" });
    expect(await mailQueueService.listIgnored()).toEqual([]);
    expect((await ignoreRows())[1]).toMatchObject({ receiptId: null, userId: FINANCE.id, action: "file_unignored", valueBefore: "logo", valueAfter: "newsletter logo" });
    await expect(mailQueueService.removeIgnored(entry.id)).rejects.toMatchObject({ status: 404 });
  });
});
