/** List routes return one page: 50 rows by default, never more than 200 whatever `limit` asks. */
import { beforeEach, expect, it } from "vitest";
import { describeDb } from "../helpers/db";
import { ORG } from "../helpers/seed";
import { db } from "../../db";
import { finance } from "../../routes";

const ROWS = 201;

async function exclusions(query: string): Promise<unknown> {
  const out = await finance.qbExclusions({ req: new Request(`http://test/api/expense/qb-exclusions${query}`), params: {} });
  return out.ExpenseQbMatchExclusion;
}

describeDb("list routes page", () => {
  beforeEach(async () => {
    await db.expenseQbMatchExclusion.createMany({
      data: Array.from({ length: ROWS }, (_, i) => ({ orgId: ORG, qbTxnId: `qb-${i}`, reason: "test", excludedByUserId: 1 })),
    });
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
