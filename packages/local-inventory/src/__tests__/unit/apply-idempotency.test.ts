/**
 * Apply is idempotent per source (`receipt:<id>` / `donation:<id>`, unique per org), guarded by
 * ReceivedInventoryDelta in the same transaction as the stock change. Real Postgres; describeDb
 * skips without one.
 */
import { buildProvisionalGtin13 } from "@checkin/gtin";
import { expect, it, vi } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../lib/db/index";
import { createInventoryRepository } from "../../lib/repositories/inventoryRepository";
import { createProvisionalItemRepository } from "../../lib/repositories/provisionalItemRepository";
import { createProvisionalResolutionRepository } from "../../lib/repositories/provisionalResolutionRepository";
import { createReceiveQueueRepository } from "../../lib/repositories/receiveQueueRepository";
import { createProvisionalItemService, type ProvisionalItemService } from "../../lib/services/provisionalItemService";
import { createReceiptService } from "../../lib/services/receiptService";
import { setupIntegrationDb } from "../helpers/setup";
import { TEST_ORG_ID, TEST_ORG_ID_2 } from "../helpers/seed";

setupIntegrationDb();

function makeReceiptService(overrides: Partial<ProvisionalItemService> = {}) {
  const inventoryRepo = createInventoryRepository(db);
  const provisionalRepo = createProvisionalItemRepository(db);
  return createReceiptService({
    provisionalItemService: {
      ...createProvisionalItemService({
        provisionalRepo,
        resolutionRepo: createProvisionalResolutionRepository(db),
        inventoryRepo,
        db,
      }),
      ...overrides,
    },
    inventoryRepo,
    receiveQueueRepo: createReceiveQueueRepository(db),
    db,
  });
}

const GTIN = "0000000000017";
const PROV = buildProvisionalGtin13(1);

async function qty(orgId: string, gtin13 = GTIN) {
  return (await db.orgItem.findFirst({ where: { orgId, gtin13 } }))?.existingQuantity ?? 0;
}

describeDb("apply idempotency", () => {
  it("a replayed receipt changes nothing and returns the earlier result", async () => {
    const svc = makeReceiptService();
    const lines = [
      { gtin13: GTIN, quantityDelta: 3 },
      { gtin13: "0000000000024", quantityDelta: 2, isDelayed: true, lineItemId: 7 },
    ];

    const first = await svc.applyReceipt(TEST_ORG_ID, "r-1", "Costco", lines);
    const again = await svc.applyReceipt(TEST_ORG_ID, "r-1", "Costco", lines);

    expect(first).toMatchObject({ success: true, replayed: false, updatedItems: [{ gtin13: GTIN, newQuantity: 3 }] });
    expect(again).toEqual({ ...first, replayed: true });
    expect(await qty(TEST_ORG_ID)).toBe(3);
    expect(await db.receiveQueue.count()).toBe(1);
    expect(await db.inventoryLog.count({ where: { gtin13: GTIN } })).toBe(1);
    const guard = await db.receivedInventoryDelta.findMany();
    expect(guard).toEqual([
      expect.objectContaining({ orgId: TEST_ORG_ID, sourceKey: "receipt:r-1", receiptId: "r-1", status: "applied" }),
    ]);
  });

  it("a replay with a different payload after an applied apply is a 409 and changes nothing", async () => {
    const svc = makeReceiptService();
    await svc.applyReceipt(TEST_ORG_ID, "r-1", "Costco", [{ gtin13: GTIN, quantityDelta: 3 }]);

    await expect(
      svc.applyReceipt(TEST_ORG_ID, "r-1", "Costco", [{ gtin13: GTIN, quantityDelta: 4 }]),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await qty(TEST_ORG_ID)).toBe(3);
    expect(await db.receivedInventoryDelta.findFirst()).toMatchObject({ status: "applied", failureReason: null });

    // Spelling out a default is the same payload, not a different one.
    const same = await svc.applyReceipt(TEST_ORG_ID, "r-1", "Costco", [
      { gtin13: GTIN, quantityDelta: 3, conversionFactor: 1, isDelayed: false },
    ]);
    expect(same.replayed).toBe(true);
  });

  it("a replayed donation changes nothing; a receipt with the same id is a different source", async () => {
    const svc = makeReceiptService();
    const lines = [{ gtin13: GTIN, quantityDelta: 4 }];

    await svc.applyDonation(TEST_ORG_ID, "42", lines);
    const again = await svc.applyDonation(TEST_ORG_ID, "42", lines);
    await svc.applyReceipt(TEST_ORG_ID, "42", undefined, lines);

    expect(again.replayed).toBe(true);
    expect(await qty(TEST_ORG_ID)).toBe(8);
    const keys = (await db.receivedInventoryDelta.findMany({ orderBy: { id: "asc" } })).map((r) => r.sourceKey);
    expect(keys).toEqual(["donation:42", "receipt:42"]);
  });

  it("the key is unique per org, not globally", async () => {
    const svc = makeReceiptService();
    await svc.applyReceipt(TEST_ORG_ID, "r-1", undefined, [{ gtin13: GTIN, quantityDelta: 1 }]);
    await svc.applyReceipt(TEST_ORG_ID_2, "r-1", undefined, [{ gtin13: GTIN, quantityDelta: 1 }]);
    expect(await qty(TEST_ORG_ID)).toBe(1);
    expect(await qty(TEST_ORG_ID_2)).toBe(1);
  });

  it("a concurrent duplicate is a replay, not a second add", async () => {
    const svc = makeReceiptService();
    const lines = [{ gtin13: GTIN, quantityDelta: 5 }];
    const results = await Promise.all([
      svc.applyReceipt(TEST_ORG_ID, "r-2", undefined, lines),
      svc.applyReceipt(TEST_ORG_ID, "r-2", undefined, lines),
    ]);
    expect(results.map((r) => r.replayed).sort()).toEqual([false, true]);
    expect(await qty(TEST_ORG_ID)).toBe(5);
  });

  it("a failed apply rolls back, records the failure, and a retry applies once", async () => {
    const svc = makeReceiptService();
    // 3e9 overflows the INTEGER quantity column, failing the second line after the first wrote.
    const bad = [{ gtin13: GTIN, quantityDelta: 2 }, { gtin13: "0000000000024", quantityDelta: 3_000_000_000 }];
    await expect(svc.applyReceipt(TEST_ORG_ID, "r-3", undefined, bad)).rejects.toThrow();
    expect(await qty(TEST_ORG_ID)).toBe(0);
    expect(await db.receivedInventoryDelta.findFirst()).toMatchObject({ sourceKey: "receipt:r-3", status: "failed" });
    expect((await db.receivedInventoryDelta.findFirst())?.failureReason).toBeTruthy();

    const retry = await svc.applyReceipt(TEST_ORG_ID, "r-3", undefined, [{ gtin13: GTIN, quantityDelta: 2 }]);
    await svc.applyReceipt(TEST_ORG_ID, "r-3", undefined, [{ gtin13: GTIN, quantityDelta: 2 }]);
    expect(retry.replayed).toBe(false);
    expect(await qty(TEST_ORG_ID)).toBe(2);
    expect(await db.receivedInventoryDelta.findMany()).toEqual([
      expect.objectContaining({ sourceKey: "receipt:r-3", status: "applied", failureReason: null }),
    ]);
  });

  it("rejects malformed input at the boundary before touching stock", async () => {
    const svc = makeReceiptService();
    const bad: Array<[string, string, number, number | undefined]> = [
      ["blank org", " ", 1, undefined],
      ["zero quantity", TEST_ORG_ID, 0, undefined],
      ["negative quantity", TEST_ORG_ID, -2, undefined],
      ["fractional quantity", TEST_ORG_ID, 1.5, undefined],
      ["zero conversion factor", TEST_ORG_ID, 1, 0],
    ];
    for (const [label, orgId, quantityDelta, conversionFactor] of bad) {
      await expect(
        svc.applyReceipt(orgId, "r-bad", undefined, [{ gtin13: GTIN, quantityDelta, conversionFactor }]),
        label,
      ).rejects.toMatchObject({ statusCode: 400 });
    }
    await expect(svc.applyDonation(TEST_ORG_ID, "", [{ gtin13: GTIN, quantityDelta: 1 }])).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(await qty(TEST_ORG_ID)).toBe(0);
    expect(await db.receivedInventoryDelta.count()).toBe(0);
  });

  it("a reconcile that throws after commit still reports success, and a retry is a replay", async () => {
    const reconcileProvisionalOnCreate = vi.fn(async () => {
      throw new Error("lock timeout");
    });
    const svc = makeReceiptService({ reconcileProvisionalOnCreate });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const lines = [{ gtin13: PROV, quantityDelta: 2, isProvisional: true, provisionalName: "Widget" }];

    const first = await svc.applyReceipt(TEST_ORG_ID, "r-1", "Costco", lines);
    const again = await svc.applyReceipt(TEST_ORG_ID, "r-1", "Costco", lines);

    expect(reconcileProvisionalOnCreate).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalled();
    expect(first).toMatchObject({ success: true, replayed: false, updatedItems: [{ gtin13: PROV, newQuantity: 2 }] });
    expect(again).toEqual({ ...first, replayed: true });
    expect(await qty(TEST_ORG_ID, PROV)).toBe(2);
    expect(await db.receivedInventoryDelta.findFirst()).toMatchObject({ status: "applied", failureReason: null });
    logged.mockRestore();
  });
});
