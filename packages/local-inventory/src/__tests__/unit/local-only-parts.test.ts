/**
 * A provisional part the catalog rejects stays the org's local-only part: receipts land on it,
 * its stock moves and edits go through, and the stock reads mark it. Real Postgres; describeDb
 * skips without one.
 */
import { beforeEach, expect, it } from "vitest";
import { buildProvisionalGtin13 } from "@checkin/gtin";
import { describeDb } from "../helpers/db";
import { db } from "../../lib/db/index";
import { createInventoryRepository } from "../../lib/repositories/inventoryRepository";
import { createProvisionalItemRepository } from "../../lib/repositories/provisionalItemRepository";
import { createProvisionalResolutionRepository } from "../../lib/repositories/provisionalResolutionRepository";
import { createReceiveQueueRepository } from "../../lib/repositories/receiveQueueRepository";
import { createProvisionalItemService } from "../../lib/services/provisionalItemService";
import { createReceiptService } from "../../lib/services/receiptService";
import { get, update } from "../../routes/orgItems";
import { configureLocalInventory } from "../../runtime";
import { setupIntegrationDb } from "../helpers/setup";
import { TEST_ORG_ID } from "../helpers/seed";

setupIntegrationDb();

const PROV = buildProvisionalGtin13(42);

function services() {
  const inventoryRepo = createInventoryRepository(db);
  const provisionalItemService = createProvisionalItemService({
    provisionalRepo: createProvisionalItemRepository(db),
    resolutionRepo: createProvisionalResolutionRepository(db),
    inventoryRepo,
    db,
  });
  const receiptService = createReceiptService({ provisionalItemService, inventoryRepo, receiveQueueRepo: createReceiveQueueRepository(db), db });
  return { provisionalItemService, receiptService };
}

const qty = async () => (await db.orgItem.findFirst({ where: { orgId: TEST_ORG_ID, gtin13: PROV } }))?.existingQuantity;

/** A provisional part received on one receipt, then rejected by the catalog. */
async function rejectedPart() {
  const { provisionalItemService, receiptService } = services();
  await receiptService.applyReceipt(TEST_ORG_ID, "r-1", "Costco", [{ gtin13: PROV, quantityDelta: 2, isProvisional: true, provisionalName: "Widget" }]);
  await provisionalItemService.rejectProvisional(TEST_ORG_ID, PROV, "not a catalog part");
  return receiptService;
}

describeDb("a catalog-rejected provisional part", () => {
  beforeEach(() => {
    configureLocalInventory({
      auth: { getPrincipal: async () => ({ id: 1, name: "Manager" }) },
      org: async () => ({ id: TEST_ORG_ID, name: "Org One" }),
      catalog: { searchItems: async () => [], getActiveItem: async () => null },
    });
  });

  it("keeps its stock under its own Part ID when rejected", async () => {
    await rejectedPart();
    expect(await db.inventoryProvisionalItem.findFirst({ where: { provisionalGtin13: PROV } })).toMatchObject({ status: "rejected", resolvedToGtin13: null });
    expect(await qty()).toBe(2);
  });

  it("receives a later receipt onto its own Part ID", async () => {
    const receipts = await rejectedPart();
    const result = await receipts.applyReceipt(TEST_ORG_ID, "r-2", "Costco", [{ gtin13: PROV, quantityDelta: 3, isProvisional: true, provisionalName: "Widget" }]);
    expect(result).toMatchObject({ success: true, updatedItems: [{ gtin13: PROV, newQuantity: 5 }] });
    expect(await db.inventoryProvisionalItem.count({ where: { provisionalGtin13: PROV } })).toBe(1);
  });

  it("takes a stock move and a location edit", async () => {
    await rejectedPart();
    const location = await db.location.create({ data: { orgId: TEST_ORG_ID, name: "Bin 4" } });
    const body = { existingQuantity: 7, expectedQuantity: 2, locationId: location.id, expectedLocationId: null };
    const req = new Request(`http://test/api/inventory/org-items/${PROV}`, { method: "PUT", body: JSON.stringify(body) });
    expect(await update({ req, params: { gtin13: PROV } })).toMatchObject({ OrgItem: { gtin13: PROV, existingQuantity: 7, locationId: location.id } });
  });

  it("returns its status beside the row, for the Local only mark", async () => {
    await rejectedPart();
    const req = new Request(`http://test/api/inventory/org-items/${PROV}`);
    expect(await get({ req, params: { gtin13: PROV } })).toMatchObject({
      InventoryProvisionalItem: [{ provisionalGtin13: PROV, name: "Widget", status: "rejected" }],
    });
  });
});
