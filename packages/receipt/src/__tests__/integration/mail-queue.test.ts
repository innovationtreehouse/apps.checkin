import { beforeEach, expect, it } from "vitest";
import { db } from "../../db";
import { CANNOT_ASSIGN, mailQueueService } from "../../services/mailQueueService";
import { describeDb } from "../helpers/db";
import { actAs, ALICE, BOB, clearAll, configure, FINANCE, okOcr, stateOf, TEST_ORG_ID } from "../helpers/setup";

const PEOPLE: Record<string, typeof ALICE> = { "alice@example.org": ALICE, "bob@example.org": BOB, "finn@example.org": FINANCE };

let seq = 0;
async function holdItem(): Promise<number> {
  const n = ++seq;
  const item = await db.receiptMailItem.create({
    data: {
      orgId: TEST_ORG_ID,
      gmailMessageId: `m${n}`,
      attachmentHash: `h${n}`,
      receivedAt: new Date(),
      senderAddress: "stranger@elsewhere.test",
      status: "held",
      fileBlob: new Uint8Array(Buffer.from(`%PDF-1.4 held ${n} ${Date.now()}`)),
      mimeType: "application/pdf",
    },
  });
  return item.id;
}

beforeEach(async () => {
  await clearAll();
  configure({
    ocr: okOcr(),
    people: { submitterByEmail: async (address) => PEOPLE[address] ?? null },
    // Bob shares Finn's household.
    households: { householdOf: async (ids) => (ids.includes(FINANCE.id) ? [FINANCE.id, BOB.id] : []) },
  });
  actAs(FINANCE);
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

    await expect(mailQueueService.assign(id, { email: "alice@example.org" })).rejects.toMatchObject({ statusCode: 404 });
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
    await expect(mailQueueService.assign(id, { email })).rejects.toMatchObject({ statusCode: 403 });
    expect(await db.receipt.count()).toBe(0);
    expect(await db.receiptMailItem.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "held" });
    expect(await db.receiptAuditLog.count({ where: { action: "mail_assign_refused", valueBefore: String(id) } })).toBe(1);
  });

  it("answers one status and message for every email it cannot assign to", async () => {
    const id = await holdItem();
    // The host port answers null alike for no one, several people, unverified sign-in and a failed submitter gate.
    for (const email of ["nobody@example.org", "unverified@example.org"]) {
      await expect(mailQueueService.assign(id, { email })).rejects.toMatchObject({ statusCode: 404, message: CANNOT_ASSIGN });
    }
    await expect(mailQueueService.assign(id, {})).rejects.toMatchObject({ statusCode: 400 });
    expect(await db.receipt.count()).toBe(0);
  });

  it("discards only with a reason, clears the file and audits the reason", async () => {
    const id = await holdItem();
    for (const body of [{}, { reason: "   " }]) {
      await expect(mailQueueService.discard(id, body)).rejects.toMatchObject({ statusCode: 400 });
    }
    expect(await mailQueueService.discard(id, { reason: "newsletter" })).toMatchObject({ id, status: "discarded" });
    expect(await db.receiptMailItem.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "discarded", fileBlob: null });
    expect(await db.receiptAuditLog.findFirst({ where: { action: "mail_discarded" } })).toMatchObject({
      receiptId: null,
      userId: FINANCE.id,
      valueBefore: String(id),
      valueAfter: "newsletter",
    });
    await expect(mailQueueService.discard(id, { reason: "again" })).rejects.toMatchObject({ statusCode: 404 });
    await expect(mailQueueService.getFile(id)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("serves a held file and audits the read", async () => {
    const id = await holdItem();
    expect(await mailQueueService.getFile(id)).toMatchObject({ id, mimeType: "application/pdf" });
    expect(await db.receiptAuditLog.count({ where: { action: "mail_file_viewed", valueBefore: String(id) } })).toBe(1);
  });
});
