/**
 * What in expense still needs a bucket: lines on an open expense and parts mapped to it. A closed
 * expense doesn't count.
 */
import { it, expect } from "vitest";
import { describeDb } from "../helpers/db";
import { seedApproval, seedExpense, seedLineItem, seedPartOwner } from "../helpers/seed";
import { unfinishedBucketUses } from "../../services/bucketUses";

const BUCKET = 7;
const OTHER = 8;

async function lineIn(state: string, ownerId: number) {
  const id = await seedExpense({ state });
  await seedApproval(id, await seedLineItem(id), { ownerId });
}

describeDb("expense unfinishedBucketUses", () => {
  it("is empty for a bucket nothing points at", async () => {
    await lineIn("owner_approval", OTHER);
    expect(await unfinishedBucketUses(BUCKET)).toEqual([]);
  });

  it("counts open lines and part maps; not closed expenses", async () => {
    await lineIn("owner_approval", BUCKET);
    await lineIn("qb_pending", BUCKET);
    for (const closed of ["qb_complete", "qb_skipped", "rejected"]) await lineIn(closed, BUCKET);
    await seedPartOwner({ gtin13: "0000000000017", ownerId: BUCKET });
    await seedPartOwner({ gtin13: "0000000000024", ownerId: OTHER });
    expect(await unfinishedBucketUses(BUCKET)).toEqual([
      { what: "open expense lines", count: 2, where: "Finance › Expenses" },
      { what: "parts mapped to it for future receipts", count: 1, where: "Finance › Part Buckets" },
    ]);
  });
});
