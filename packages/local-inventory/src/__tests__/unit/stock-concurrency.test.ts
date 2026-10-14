/**
 * Concurrent stock writers must not lose an add, a queued line is received once, and a
 * resolution that arrives before its provisional row keeps the event's conversion factor.
 * Real Postgres; describeDb skips without one.
 */
import { expect, it } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../lib/db/index";
import { createInventoryRepository } from "../../lib/repositories/inventoryRepository";
import { createProvisionalItemRepository } from "../../lib/repositories/provisionalItemRepository";
import { createProvisionalResolutionRepository } from "../../lib/repositories/provisionalResolutionRepository";
import { createReceiveQueueRepository } from "../../lib/repositories/receiveQueueRepository";
import { createInventoryService } from "../../lib/services/inventoryService";
import { createProvisionalItemService } from "../../lib/services/provisionalItemService";
import { createReceiptService } from "../../lib/services/receiptService";
import { createReceiveQueueService } from "../../lib/services/receiveQueueService";
import { setupIntegrationDb } from "../helpers/setup";
import { TEST_ORG_ID } from "../helpers/seed";

setupIntegrationDb();

const GTIN = "0000000000031";
const PROVISIONAL = "0200002700018";
const REAL = "0000000000048";

function services() {
  const inventoryRepo = createInventoryRepository(db);
  const provisionalItemService = createProvisionalItemService({
    provisionalRepo: createProvisionalItemRepository(db),
    resolutionRepo: createProvisionalResolutionRepository(db),
    inventoryRepo,
    db,
  });
  const receiveQueueRepo = createReceiveQueueRepository(db);
  return {
    inventory: createInventoryService({ inventoryRepo, db }),
    provisional: provisionalItemService,
    receipts: createReceiptService({ provisionalItemService, inventoryRepo, receiveQueueRepo, db }),
    queue: createReceiveQueueService({ receiveQueueRepo, db }),
  };
}

async function qty(gtin13: string) {
  return (await db.orgItem.findFirst({ where: { orgId: TEST_ORG_ID, gtin13 } }))?.existingQuantity ?? 0;
}

describeDb("stock write concurrency", () => {
  it("concurrent receipts on one GTIN keep every add", async () => {
    const { receipts } = services();
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => receipts.applyReceipt(TEST_ORG_ID, `c-${i}`, undefined, [{ gtin13: GTIN, quantityDelta: 2 }])),
    );
    expect(await qty(GTIN)).toBe(20);
    const after = (await db.inventoryLog.findMany({ where: { gtin13: GTIN } })).map((l) => Number(l.valueAfter)).sort((a, b) => a - b);
    expect(after).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
  });

  it("concurrent fulfils of one queued line add its stock once", async () => {
    const { queue } = services();
    const line = await db.receiveQueue.create({
      data: { orgId: TEST_ORG_ID, gtin13: GTIN, quantity: 3, conversionFactor: 2, receiptId: "q-1", lineItemId: 1 },
    });
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => queue.fulfill(line.id, TEST_ORG_ID, 1)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await qty(GTIN)).toBe(6);
  });

  it("a merge racing receipts on the provisional and real GTINs keeps every add", async () => {
    const { receipts, provisional } = services();
    await receipts.applyReceipt(TEST_ORG_ID, "m-0", undefined, [
      { gtin13: PROVISIONAL, quantityDelta: 5, isProvisional: true },
      { gtin13: REAL, quantityDelta: 7 },
    ]);
    await Promise.all([
      provisional.mapProvisionalToExisting(TEST_ORG_ID, PROVISIONAL, REAL, 1),
      ...Array.from({ length: 5 }, (_, i) => receipts.applyReceipt(TEST_ORG_ID, `m-${i + 1}`, undefined, [{ gtin13: REAL, quantityDelta: 1 }])),
    ]);
    expect(await qty(REAL)).toBe(17);
  });

  it("concurrent conflict resolves apply once", async () => {
    const { provisional } = services();
    await db.orgItem.createMany({
      data: [
        { orgId: TEST_ORG_ID, gtin13: PROVISIONAL, existingQuantity: 4 },
        { orgId: TEST_ORG_ID, gtin13: REAL, existingQuantity: 6 },
      ],
    });
    const conflict = await db.inventoryMergeConflict.create({
      data: { orgId: TEST_ORG_ID, provisionalGtin13: PROVISIONAL, realGtin13: REAL, conflictType: "uom_mismatch", sourceEventId: 9 },
    });
    const results = await Promise.allSettled(
      Array.from({ length: 3 }, () => provisional.resolveConflict(conflict.id, TEST_ORG_ID, { quantityMethod: "sum" }, 1)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await qty(REAL)).toBe(10);
    expect(await db.inventoryLog.count({ where: { gtin13: REAL } })).toBe(1);
  });
});

describeDb("reconcile-on-create conversion factor", () => {
  it("a resolution recorded before its provisional row merges under the event's factor", async () => {
    const { receipts, provisional } = services();
    await db.orgItem.create({ data: { orgId: TEST_ORG_ID, gtin13: REAL, existingQuantity: 12 } });

    // Event first: the real item counts in packs of 6. No provisional row exists yet.
    await provisional.mapProvisionalToExisting(TEST_ORG_ID, PROVISIONAL, REAL, 77, 6);
    expect(await db.inventoryProvisionalResolution.findFirst()).toMatchObject({ conversionFactor: 6 });

    // The provisional arrives counted as each (factor 1): units differ, so it parks a conflict.
    await receipts.applyReceipt(TEST_ORG_ID, "f-1", undefined, [{ gtin13: PROVISIONAL, quantityDelta: 3, isProvisional: true }]);

    expect(await db.inventoryMergeConflict.findFirst()).toMatchObject({
      conflictType: "uom_mismatch", provisionalConversionFactor: 1, existingConversionFactor: 6, sourceEventId: 77,
    });
    expect(await qty(REAL)).toBe(12);
  });
});
