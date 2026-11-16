/**
 * What in bulk-donation still needs a bucket: Benevity gifts until income takes their
 * disbursement, and gifts of goods until booked, refused or returned. Comment rules don't count.
 */
import { it, expect, beforeEach } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { configureBulkDonation } from "../../runtime";
import type { DonationDepositStatus, IncomeDeposits } from "../../contract";
import { makeEvent, makeFile, makeTransaction, TEST_ORG_ID, TEST_OWNERS } from "../helpers/factories";
import { unfinishedBucketUses } from "../../services/bucketUses";

const orgId = TEST_ORG_ID;
const BUCKET = 9;
const OTHER = 1;

/** Income knows the disbursements in `taken`. */
function bind(taken: string[]) {
  const deposits: IncomeDeposits = {
    prod: false,
    expectDeposit: async () => "recorded",
    handOverFailing: async () => {},
    depositStatus: async (_orgId, ids) =>
      Object.fromEntries(ids.filter((id) => taken.includes(id)).map((id): [string, DonationDepositStatus] => [id, { state: "waiting" }])),
  };
  configureBulkDonation({
    auth: { getPrincipal: async () => ({ id: 1, name: "testfinance" }) },
    org: async () => ({ id: orgId, name: "Test Org" }),
    owners: { list: async () => TEST_OWNERS },
    deposits,
  });
}

async function gift(disbursementId: string, ownerId: number, overrides: { feeReleasedAt?: Date } = {}) {
  const { id: fileId } = await makeFile(orgId);
  const tx = await makeTransaction(orgId, fileId, { disbursementId, ownerId });
  if (overrides.feeReleasedAt) await db.transaction.update({ where: { id: tx.id }, data: { feeReleasedAt: overrides.feeReleasedAt } });
}

let receipts = 0;
async function goods(source: "receipt" | "manual", budgetOwnerId: number, decisionOutcome: string | null) {
  const decision = { decisionOutcome, budgetOwnerId };
  const { id } =
    source === "receipt"
      ? await db.inKindDonation.create({ data: { orgId, receiptId: `r-${++receipts}`, ...decision } })
      : await db.manualInKindDonation.create({ data: { orgId, donorFirstName: "Ada", donorLastName: "Lovelace", donationDate: "2026-10-01", recordedByUserId: 1, ...decision } });
  return id;
}

async function book(source: string, giftId: number, sides: Record<string, string>) {
  for (const [side, matchState] of Object.entries(sides)) await db.inKindBooking.create({ data: { orgId, source, giftId, side, matchState } });
}

beforeEach(async () => {
  await db.inKindBooking.deleteMany({});
  await db.inKindPosting.deleteMany({});
  await db.inKindDonation.deleteMany({});
  await db.manualInKindDonation.deleteMany({});
  await db.transactionCommentRule.deleteMany({});
  await db.disbursementEvent.deleteMany({});
  await db.transaction.deleteMany({});
  await db.uploadedFile.deleteMany({});
  bind([]);
});

describeDb("bulk-donation unfinishedBucketUses", () => {
  it("is empty for a bucket nothing points at, and a comment rule does not count", async () => {
    await gift("open-other", OTHER);
    await db.transactionCommentRule.create({ data: { orgId, comment: "for robotics", ownerId: BUCKET, createdByUserId: 1 } });
    expect(await unfinishedBucketUses(BUCKET)).toEqual([]);
  });

  it("counts a Benevity gift until income takes its disbursement", async () => {
    await gift("open", BUCKET);
    await gift("TEST-not-taken", BUCKET);
    await makeEvent(orgId, "TEST-not-taken");
    await gift("TEST-taken", BUCKET);
    await makeEvent(orgId, "TEST-taken");
    await gift("released", BUCKET, { feeReleasedAt: new Date() });
    await gift("never-handed", BUCKET);
    // Outside prod only a TEST- disbursement is handed over, so income takes "never-handed" never; it counts as done.
    await makeEvent(orgId, "never-handed");
    bind(["TEST-taken"]);
    expect(await unfinishedBucketUses(BUCKET)).toEqual([{ what: "Benevity gifts not yet deposited", count: 2, where: "Donations › Gifts" }]);
  });

  it("counts gifts of goods until booked, skipped, refused or returned", async () => {
    await goods("receipt", BUCKET, null);
    await goods("manual", BUCKET, "ACCEPTED");
    const halfBooked = await goods("receipt", BUCKET, "ACCEPTED");
    await book("receipt", halfBooked, { revenue: "MATCHED" });
    const journal = await goods("receipt", BUCKET, "ACCEPTED");
    await book("receipt", journal, { journal: "CREATED" });
    const byHand = await goods("manual", BUCKET, "ACCEPTED");
    await book("manual", byHand, { revenue: "MATCHED", expense: "CREATED" });
    const skipped = await goods("manual", BUCKET, "ACCEPTED");
    await db.inKindPosting.create({ data: { orgId, source: "manual", giftId: skipped, matchState: "DISMISSED" } });
    await goods("receipt", BUCKET, "REFUSED");
    await goods("manual", BUCKET, "RETURNED");
    await goods("manual", OTHER, "ACCEPTED");
    expect(await unfinishedBucketUses(BUCKET)).toEqual([{ what: "gifts of goods not yet booked", count: 3, where: "Donations › Queue" }]);
  });
});
