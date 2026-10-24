/** The flow status page's receiving counts: raw org-wide totals per state. */
import { beforeEach, expect, it } from "vitest";
import { receivingStateCounts } from "../../services/stateCounts";
import { describeDb } from "../helpers/db";
import { OTHER_ORG_ID, clearAll, configure, makeReceipt } from "../helpers/setup";

beforeEach(async () => {
  await clearAll();
  configure();
});

describeDb("receivingStateCounts", () => {
  it("is zero in every state for an org with no received receipts", async () => {
    expect((await receivingStateCounts()).map((s) => [s.state, s.count])).toEqual([
      ["pending_review", 0], ["applying", 0], ["apply_failed", 0], ["resolved", 0],
    ]);
  });

  it("counts this org's received receipts per state", async () => {
    await makeReceipt({ state: "applying" });
    await makeReceipt({ state: "applying" });
    await makeReceipt({ state: "resolved" });
    await makeReceipt({ state: "applying", orgId: OTHER_ORG_ID });
    expect((await receivingStateCounts()).map((s) => [s.state, s.count])).toEqual([
      ["pending_review", 0], ["applying", 2], ["apply_failed", 0], ["resolved", 1],
    ]);
  });
});
