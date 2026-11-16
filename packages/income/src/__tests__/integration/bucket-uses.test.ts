/**
 * What in income still needs a bucket: store items mapped to it, and Benevity deposits with a line
 * in it until posted, matched or resolved.
 */
import { it, expect, beforeEach, afterEach } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { configureIncome, incomeRuntime } from "../../runtime";
import { clearAll, ORG_A } from "../helpers/fixtures";
import { unfinishedBucketUses } from "../../services/bucketUses";

const BUCKET = 7;
const OTHER = 8;

let gid = 0;
async function deposit(status: string, buckets: (number | null)[]) {
  const lines = buckets.map((budgetOwnerId) => ({ accountId: "60", budgetOwnerId, amountCents: 500 }));
  const expected = { txnDate: "2026-10-01", netCents: 500 * lines.length, bankRole: "BENEVITY_BANK", lines };
  await db.payoutReconciliation.create({
    data: { orgId: ORG_A, source: "benevity", payoutGid: `d-${++gid}`, payoutDate: "2026-10-01", payoutNetCents: expected.netCents, status, expected },
  });
}

beforeEach(async () => {
  await clearAll();
  configureIncome({ auth: { getPrincipal: async () => ({ id: 1, name: "finance" }) }, org: async () => ({ id: ORG_A, name: "Org A" }) });
});
afterEach(() => incomeRuntime.reset());

describeDb("income unfinishedBucketUses", () => {
  it("is empty for a bucket nothing points at", async () => {
    await db.incomeItemCategory.create({ data: { orgId: ORG_A, variantId: "41", budgetOwnerId: OTHER } });
    await deposit("WAITING", [OTHER, null]);
    expect(await unfinishedBucketUses(BUCKET)).toEqual([]);
  });

  it("counts mapped store items and Benevity deposits not yet posted; not posted, matched or resolved ones", async () => {
    await db.incomeItemCategory.create({ data: { orgId: ORG_A, variantId: "42", budgetOwnerId: BUCKET } });
    await db.incomeItemCategory.create({ data: { orgId: ORG_A, variantId: "43", budgetOwnerId: null } });
    await deposit("WAITING", [OTHER, BUCKET]);
    await deposit("OPEN", [BUCKET]);
    for (const settled of ["POSTED", "MATCHED", "RESOLVED"]) await deposit(settled, [BUCKET]);
    expect(await unfinishedBucketUses(BUCKET)).toEqual([
      { what: "store items mapped to it", count: 1, where: "Income › Item Categories" },
      { what: "Benevity deposits not yet posted", count: 2, where: "Income › Reconciliation" },
    ]);
  });
});
