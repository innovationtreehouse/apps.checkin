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
import { applyQtyChangeIn, createInventoryService } from "../../lib/services/inventoryService";
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

/** Resolves once some backend in this database is waiting on a lock. */
async function someoneBlocked(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const [{ n }] = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (n > 0n) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("no backend blocked on a lock");
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

  it("a rename merge racing the first receipt on the real GTIN keeps both counts", async () => {
    const { receipts, provisional } = services();
    await receipts.applyReceipt(TEST_ORG_ID, "r-0", undefined, [{ gtin13: PROVISIONAL, quantityDelta: 5, isProvisional: true }]);

    // The first receipt on the real GTIN holds its new row uncommitted while the merge runs.
    let commit!: () => void;
    const gate = new Promise<void>((r) => (commit = r));
    let inserted!: () => void;
    const rowInserted = new Promise<void>((r) => (inserted = r));
    const receipt = db.$transaction(async (tx) => {
      await applyQtyChangeIn(tx, TEST_ORG_ID, REAL, 3, { userId: null, changeType: "received", receiptId: "r-1" });
      inserted();
      await gate;
    });
    await rowInserted;
    const merge = provisional.mapProvisionalToExisting(TEST_ORG_ID, PROVISIONAL, REAL, 1);
    await someoneBlocked();
    commit();
    await Promise.all([receipt, merge]);

    expect(await qty(REAL)).toBe(8);
    expect(await db.orgItem.findFirst({ where: { orgId: TEST_ORG_ID, gtin13: PROVISIONAL } })).toBeNull();
  });

  it("an edit without a count, racing a receipt add, keeps the add", async () => {
    const { inventory } = services();
    await db.orgItem.create({ data: { orgId: TEST_ORG_ID, gtin13: GTIN, existingQuantity: 1 } });

    let commit!: () => void;
    const gate = new Promise<void>((r) => (commit = r));
    let added!: () => void;
    const rowAdded = new Promise<void>((r) => (added = r));
    const receipt = db.$transaction(async (tx) => {
      await applyQtyChangeIn(tx, TEST_ORG_ID, GTIN, 1, { userId: null, changeType: "received", receiptId: "p-1" });
      added();
      await gate;
    });
    await rowAdded;
    const edit = inventory.updateItem(TEST_ORG_ID, GTIN, { desiredQuantity: 4 }, 1);
    await someoneBlocked();
    commit();
    await Promise.all([receipt, edit]);

    expect(await db.orgItem.findFirst({ where: { orgId: TEST_ORG_ID, gtin13: GTIN } })).toMatchObject({
      existingQuantity: 2, desiredQuantity: 4,
    });
    expect(await db.inventoryLog.findMany({ where: { gtin13: GTIN, changeType: "manual" } })).toMatchObject([
      { fieldChanged: "desiredQuantity", valueBefore: "0", valueAfter: "4" },
    ]);
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

describeDb("merge after a concurrent resolution", () => {
  const provisionalItem = (conversionFactor: number) =>
    db.inventoryProvisionalItem.create({
      data: { orgId: TEST_ORG_ID, provisionalGtin13: PROVISIONAL, name: "Widget", usageBehavior: "Unknown", conversionFactor },
    });

  it("a merge that read the status before a reconcile renamed the provisional does nothing", async () => {
    const { provisional: reconcile } = services();
    await provisionalItem(2);
    await db.orgItem.create({ data: { orgId: TEST_ORG_ID, gtin13: PROVISIONAL, existingQuantity: 4 } });

    // The call-out reads the provisional as pending, then waits while the reconcile renames it.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let read!: () => void;
    const statusRead = new Promise<void>((r) => (read = r));
    const repo = createProvisionalItemRepository(db);
    const stale = createProvisionalItemService({
      provisionalRepo: {
        ...repo,
        findByGtin: async (orgId, gtin13) => {
          const row = await repo.findByGtin(orgId, gtin13);
          read();
          await gate;
          return row;
        },
      },
      resolutionRepo: createProvisionalResolutionRepository(db),
      inventoryRepo: createInventoryRepository(db),
      db,
    });
    const callOut = stale.mapProvisionalToExisting(TEST_ORG_ID, PROVISIONAL, REAL, 5, 1);
    await statusRead;
    await reconcile.mapProvisionalToExisting(TEST_ORG_ID, PROVISIONAL, REAL, 5, 1);
    release();
    await callOut;

    expect(await qty(REAL)).toBe(4);
    expect(await db.inventoryMergeConflict.count()).toBe(0);
    expect(await db.provisionalItemLog.count()).toBe(1);
  });

  it("a queued provisional line with an open unit conflict lands on the provisional GTIN", async () => {
    const { queue } = services();
    await db.inventoryProvisionalItem.update({
      where: { id: (await provisionalItem(2)).id },
      data: { status: "mapped_to_existing", resolvedToGtin13: REAL },
    });
    await db.orgItem.createMany({
      data: [
        { orgId: TEST_ORG_ID, gtin13: PROVISIONAL, existingQuantity: 4 },
        { orgId: TEST_ORG_ID, gtin13: REAL, existingQuantity: 6 },
      ],
    });
    await db.inventoryMergeConflict.create({
      data: {
        orgId: TEST_ORG_ID, provisionalGtin13: PROVISIONAL, realGtin13: REAL, conflictType: "uom_mismatch",
        provisionalConversionFactor: 2, existingConversionFactor: 1, sourceEventId: 11,
      },
    });
    const line = await db.receiveQueue.create({
      data: { orgId: TEST_ORG_ID, gtin13: PROVISIONAL, quantity: 1, conversionFactor: 2, receiptId: "d-1", lineItemId: 1 },
    });

    await queue.fulfill(line.id, TEST_ORG_ID, 1);

    expect(await qty(PROVISIONAL)).toBe(6);
    expect(await qty(REAL)).toBe(6);
  });
});
