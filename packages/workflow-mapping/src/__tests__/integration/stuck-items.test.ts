/** The Problems list's read port: receipts whose apply failed and catalog events whose reaction failed. */
import { beforeEach, expect, it } from "vitest";
import { db } from "../../db";
import { stuckItems } from "../../stuckItems";
import { describeDb } from "../helpers/db";
import { OTHER_ORG_ID, TEST_ORG_ID, clearAll, configure, makeReceipt } from "../helpers/setup";

beforeEach(async () => {
  await clearAll();
  configure();
});

describeDb("stuckItems", () => {
  it("lists an apply_failed receipt with its receiving page, and a failed catalog event with no page", async () => {
    const failed = await makeReceipt({ state: "apply_failed" });
    await makeReceipt({ state: "pending_review" });
    await makeReceipt({ state: "apply_failed", orgId: OTHER_ORG_ID });
    const failedAt = new Date("2026-11-01T10:00:00Z");
    await db.workflowFailedOrgEvent.create({ data: { id: 41, orgId: TEST_ORG_ID, eventType: "item_reviewed", payload: "{}", failureReason: "boom", failedAt } });
    await db.workflowFailedOrgEvent.create({ data: { id: 42, orgId: OTHER_ORG_ID, eventType: "item_reviewed", payload: "{}", failureReason: "boom" } });

    const items = await stuckItems();

    expect(items).toEqual([
      { id: failed.receiptId, step: "apply", href: `/inventory/receiving/${failed.receiptId}`, failedAt: failed.updatedAt },
      { id: "41", step: "catalog event", href: null, failedAt },
    ]);
  });
});
