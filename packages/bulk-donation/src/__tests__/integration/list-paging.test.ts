/** List routes return one page: 50 rows by default, never more than 200 whatever `limit` asks. */
import { beforeEach, expect, it } from "vitest";
import { describeDb } from "../helpers/db";
import { configureTestRuntime, TEST_ORG_ID } from "../helpers/factories";
import { db } from "../../db";
import { disbursements } from "../../routes";

const ROWS = 201;

async function events(query: string): Promise<unknown> {
  const out = await disbursements.listEvents({ req: new Request(`http://test/api/donations/disbursement-events${query}`), params: {} });
  return out.DisbursementEvent;
}

describeDb("list routes page", () => {
  beforeEach(async () => {
    await db.disbursementEvent.deleteMany({});
    await db.disbursementEvent.createMany({
      data: Array.from({ length: ROWS }, (_, i) => ({ orgId: TEST_ORG_ID, disbursementId: `D-${i}`, payload: "{}" })),
    });
    configureTestRuntime();
  });

  it("returns 50 rows by default", async () => {
    expect(await events("")).toHaveLength(50);
  });

  it("caps limit at 200", async () => {
    expect(await events("?limit=1000")).toHaveLength(200);
  });

  it("returns the rest on the next page", async () => {
    expect(await events("?limit=200&page=2")).toHaveLength(1);
  });
});
