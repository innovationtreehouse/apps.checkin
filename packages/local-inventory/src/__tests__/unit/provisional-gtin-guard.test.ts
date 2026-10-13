/** Stock enters under a provisional GTIN only when the GTIN is in the provisional range. */
import { expect, it } from "vitest";
import { buildProvisionalGtin13 } from "@inventory/gtin";
import { describeDb } from "../helpers/db";
import { db } from "../../lib/db/index";
import { createInventoryRepository } from "../../lib/repositories/inventoryRepository";
import { createProvisionalItemRepository } from "../../lib/repositories/provisionalItemRepository";
import { createProvisionalResolutionRepository } from "../../lib/repositories/provisionalResolutionRepository";
import { createReceiveQueueRepository } from "../../lib/repositories/receiveQueueRepository";
import { createProvisionalItemService } from "../../lib/services/provisionalItemService";
import { createReceiptService } from "../../lib/services/receiptService";
import { useIntegrationSetup } from "../helpers/setup";
import { TEST_ORG_ID } from "../helpers/seed";

useIntegrationSetup();

function makeReceiptService() {
  const inventoryRepo = createInventoryRepository(db);
  return createReceiptService({
    provisionalItemService: createProvisionalItemService({
      provisionalRepo: createProvisionalItemRepository(db),
      resolutionRepo: createProvisionalResolutionRepository(db),
      inventoryRepo,
      db,
    }),
    inventoryRepo,
    receiveQueueRepo: createReceiveQueueRepository(db),
    db,
  });
}

const REAL_GTIN = "0000000000017";

describeDb("provisional GTIN guard", () => {
  it("refuses a provisional receipt line carrying a non-provisional GTIN", async () => {
    const svc = makeReceiptService();
    await expect(
      svc.applyReceipt(TEST_ORG_ID, "r-guard", undefined, [{ gtin13: REAL_GTIN, quantityDelta: 1, isProvisional: true }]),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(await db.inventoryProvisionalItem.count()).toBe(0);
  });

  it("accepts a provisional receipt line carrying a provisional GTIN", async () => {
    const svc = makeReceiptService();
    const gtin13 = buildProvisionalGtin13(1);
    await svc.applyReceipt(TEST_ORG_ID, "r-ok", undefined, [{ gtin13, quantityDelta: 1, isProvisional: true }]);
    expect(await db.inventoryProvisionalItem.count({ where: { provisionalGtin13: gtin13 } })).toBe(1);
  });

  it("refuses createProvisional for a non-provisional GTIN", async () => {
    const svc = makeReceiptService();
    await expect(
      svc.createProvisional(TEST_ORG_ID, {
        provisionalGtin13: REAL_GTIN, name: "x", usageBehavior: "Durable", proposedByUserId: 1, receiptId: "r-1",
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
