/**
 * What in expense still needs a bucket: lines on an open expense, donated lines waiting for
 * capital review, and parts mapped to it. A closed expense and a reviewed line don't count.
 */
import { it, expect } from "vitest";
import { db } from "../../db";
import { describeDb } from "../helpers/db";
import { ORG, seedApproval, seedExpense, seedLineItem, seedPartOwner } from "../helpers/seed";
import { unfinishedBucketUses } from "../../services/bucketUses";

const BUCKET = 7;
const OTHER = 8;

async function lineIn(state: string, ownerId: number) {
  const id = await seedExpense({ state });
  await seedApproval(id, await seedLineItem(id), { ownerId });
}

async function donatedLine(budgetOwnerId: number, giftLineId: number, reviewedAt: Date | null) {
  await db.donatedCapitalLine.create({
    data: { orgId: ORG, giftSource: "receipt", giftId: 1, giftLineId, description: "Lathe", quantity: 1, costCents: 50_000, budgetOwnerId, reviewedAt },
  });
}

describeDb("expense unfinishedBucketUses", () => {
  it("is empty for a bucket nothing points at", async () => {
    await lineIn("owner_approval", OTHER);
    expect(await unfinishedBucketUses(BUCKET)).toEqual([]);
  });

  it("counts open lines, unreviewed donated lines and part maps; not closed expenses or reviewed lines", async () => {
    await lineIn("owner_approval", BUCKET);
    await lineIn("qb_pending", BUCKET);
    for (const closed of ["qb_complete", "qb_skipped", "rejected"]) await lineIn(closed, BUCKET);
    await donatedLine(BUCKET, 1, null);
    await donatedLine(BUCKET, 2, new Date());
    await seedPartOwner({ gtin13: "0000000000017", ownerId: BUCKET });
    await seedPartOwner({ gtin13: "0000000000024", ownerId: OTHER });
    expect(await unfinishedBucketUses(BUCKET)).toEqual([
      { what: "open expense lines", count: 2, where: "Finance › Expenses" },
      { what: "donated lines waiting for capital review", count: 1, where: "Finance › Donated Equipment" },
      { what: "parts mapped to it for future receipts", count: 1, where: "Finance › Part Buckets" },
    ]);
  });
});
