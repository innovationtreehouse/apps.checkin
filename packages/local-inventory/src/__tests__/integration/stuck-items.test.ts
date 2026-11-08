/** The Problems list's read port: inventory deltas and catalog events that failed to apply, this org only. */
import { expect, it } from "vitest";
import { inertCatalogEventSource } from "../../contract";
import { db } from "../../lib/db/index";
import { configureLocalInventory } from "../../runtime";
import { stuckItems } from "../../stuckItems";
import { describeDb } from "../helpers/db";
import { TEST_ORG_ID, TEST_ORG_ID_2 } from "../helpers/seed";
import { setupIntegrationDb } from "../helpers/setup";

setupIntegrationDb();

describeDb("stuckItems", () => {
  it("lists failed deltas, with the receipt's page when it has one, and failed catalog events", async () => {
    configureLocalInventory({
      auth: { getPrincipal: async () => null },
      org: async () => ({ id: TEST_ORG_ID, name: "Org One" }),
      catalogEventSource: inertCatalogEventSource,
    });
    const at = new Date("2026-11-01T10:00:00Z");
    const delta = (orgId: string, sourceKey: string, status: string, receiptId: string | null) =>
      db.receivedInventoryDelta.create({ data: { orgId, sourceKey, receiptId, deltaJson: "{}", status, failureReason: "boom", receivedAt: at } });
    await delta(TEST_ORG_ID, "receipt:r1", "failed", "r1");
    const donation = await delta(TEST_ORG_ID, "donation:d1", "failed", null);
    await delta(TEST_ORG_ID, "receipt:r2", "applied", "r2");
    await delta(TEST_ORG_ID_2, "receipt:r3", "failed", "r3");
    const event = await db.inventoryReceivedOrgEvent.create({ data: { orgId: TEST_ORG_ID, eventType: "item_reviewed", payload: "{}", receivedAt: at, status: "failed", failureReason: "boom" } });
    await db.inventoryReceivedOrgEvent.create({ data: { orgId: TEST_ORG_ID, eventType: "item_reviewed", payload: "{}", receivedAt: at, status: "processed" } });

    const items = await stuckItems();

    expect(items).toEqual([
      { id: "r1", step: "inventory delta", href: "/receipts/r1", failedAt: at },
      { id: String(donation.id), step: "inventory delta", href: null, failedAt: at },
      { id: String(event.id), step: "catalog event", href: null, failedAt: at },
    ]);
  });
});
