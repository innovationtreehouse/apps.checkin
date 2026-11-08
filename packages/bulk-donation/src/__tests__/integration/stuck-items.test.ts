/** The Problems list's read port: in-kind gifts whose last QuickBooks post failed, with their gift page. */
import { beforeEach, expect, it } from "vitest";
import { db } from "../../db";
import { stuckItems } from "../../stuckItems";
import { describeDb } from "../helpers/db";
import { configureTestRuntime, TEST_ORG_ID } from "../helpers/factories";

beforeEach(async () => {
  configureTestRuntime();
  await db.inKindPosting.deleteMany({});
});

describeDb("stuckItems", () => {
  it("lists this org's gifts with a failed post, and leaves out a clean one", async () => {
    const posting = (giftId: number, qbFailureKind: string | null, orgId = TEST_ORG_ID) =>
      db.inKindPosting.create({ data: { orgId, source: "manual", giftId, matchState: qbFailureKind ? "POST_FAILED" : "CREATED", qbFailureKind } });
    const failed = await posting(1, "system");
    await posting(2, null);
    await posting(3, "system", "00000000-0000-0000-0000-000000000099");

    expect(await stuckItems()).toEqual([
      { id: "manual 1", step: "QuickBooks posting", href: "/donations/in-kind/manual/1", failedAt: failed.updatedAt },
    ]);
  });
});
