/** List routes return one page: 50 rows by default, never more than 200 whatever `limit` asks. */
import { beforeEach, expect, it } from "vitest";
import { describeDb } from "../helpers/db";
import { configureTestRuntime, TEST_ORG_ID } from "../helpers/factories";
import { db } from "../../db";
import { disbursements } from "../../routes";

const ROWS = 201;

async function exclusions(query: string): Promise<unknown> {
  const out = await disbursements.listExclusions({ req: new Request(`http://test/api/donations/qb-exclusions${query}`), params: {} });
  return out.DonationQbMatchExclusion;
}

describeDb("list routes page", () => {
  beforeEach(async () => {
    await db.donationQbMatchExclusion.deleteMany({});
    await db.donationQbMatchExclusion.createMany({
      data: Array.from({ length: ROWS }, (_, i) => ({ orgId: TEST_ORG_ID, qbTxnId: `qb-${i}`, reason: "test", excludedByUserId: 1 })),
    });
    configureTestRuntime();
  });

  it("returns 50 rows by default", async () => {
    expect(await exclusions("")).toHaveLength(50);
  });

  it("caps limit at 200", async () => {
    expect(await exclusions("?limit=1000")).toHaveLength(200);
  });

  it("returns the rest on the next page", async () => {
    expect(await exclusions("?limit=200&page=2")).toHaveLength(1);
  });
});
