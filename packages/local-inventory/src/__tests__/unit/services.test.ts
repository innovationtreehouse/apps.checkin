/**
 * Service-layer business logic against a real Postgres (the throwaway harness DB) — no
 * mocks of the data layer. describeDb skips the suite when no database URL is present, so
 * the package stays green without Docker.
 */
import { expect, it } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "@/lib/db/index";
import { createLocationRepository } from "@/lib/repositories/locationRepository";
import { createReceiveQueueRepository } from "@/lib/repositories/receiveQueueRepository";
import { createInventoryRepository } from "@/lib/repositories/inventoryRepository";
import { createProvisionalItemRepository } from "@/lib/repositories/provisionalItemRepository";
import { createLocationService } from "@/lib/services/locationService";
import { createReceiveQueueService } from "@/lib/services/receiveQueueService";
import { createInventoryService } from "@/lib/services/inventoryService";
import { ServiceError } from "@/lib/services/serviceError";
import { useIntegrationSetup } from "../helpers/setup";
import { TEST_ORG_ID, TEST_ORG_ID_2 } from "../helpers/seed";

useIntegrationSetup();

// ── Shared factory helpers ────────────────────────────────────────────────────

function makeLocationService() {
  return createLocationService({ locationRepo: createLocationRepository(db), db });
}

function makeInventoryService() {
  return createInventoryService({ inventoryRepo: createInventoryRepository(db), db });
}

function makeReceiveQueueService() {
  return createReceiveQueueService({
    receiveQueueRepo: createReceiveQueueRepository(db),
    provisionalRepo: createProvisionalItemRepository(db),
    inventoryService: makeInventoryService(),
  });
}

// ── LocationService ───────────────────────────────────────────────────────────

describeDb("LocationService", () => {
  it("creates and lists a location", async () => {
    const svc = makeLocationService();
    await svc.createLocation(TEST_ORG_ID, "  Warehouse A  ", 1);
    const list = await svc.listLocations(TEST_ORG_ID);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("Warehouse A"); // trimmed
  });

  it("lists locations scoped to org", async () => {
    const svc = makeLocationService();
    await svc.createLocation(TEST_ORG_ID, "Org1 Loc", 1);
    await svc.createLocation(TEST_ORG_ID_2, "Org2 Loc", 1);
    const list = await svc.listLocations(TEST_ORG_ID);
    expect(list.every((l) => l.orgId === TEST_ORG_ID)).toBe(true);
    expect(list).toHaveLength(1);
  });

  it("updates a location name", async () => {
    const svc = makeLocationService();
    await svc.createLocation(TEST_ORG_ID, "Old Name", 1);
    const [loc] = await svc.listLocations(TEST_ORG_ID);
    await svc.updateLocation(loc.id, TEST_ORG_ID, "New Name", 1);
    const [updated] = await svc.listLocations(TEST_ORG_ID);
    expect(updated.name).toBe("New Name");
  });

  it("throws 404 updating a non-existent location", async () => {
    const svc = makeLocationService();
    await expect(svc.updateLocation(9999, TEST_ORG_ID, "X", 1)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("throws 404 updating a location belonging to another org", async () => {
    const svc = makeLocationService();
    await svc.createLocation(TEST_ORG_ID_2, "Other org loc", 1);
    const [loc] = await svc.listLocations(TEST_ORG_ID_2);
    await expect(svc.updateLocation(loc.id, TEST_ORG_ID, "Hack", 1)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("deletes an unused location", async () => {
    const svc = makeLocationService();
    await svc.createLocation(TEST_ORG_ID, "Temp", 1);
    const [loc] = await svc.listLocations(TEST_ORG_ID);
    await svc.deleteLocation(loc.id, TEST_ORG_ID, 1);
    expect(await svc.listLocations(TEST_ORG_ID)).toHaveLength(0);
  });

  it("throws 404 deleting a non-existent location", async () => {
    const svc = makeLocationService();
    await expect(svc.deleteLocation(9999, TEST_ORG_ID, 1)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("throws 400 reassigning a location to itself", async () => {
    const svc = makeLocationService();
    await svc.createLocation(TEST_ORG_ID, "A", 1);
    const [loc] = await svc.listLocations(TEST_ORG_ID);
    await expect(svc.reassignLocation(loc.id, loc.id, TEST_ORG_ID, 1)).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("throws 404 reassigning when target location not found", async () => {
    const svc = makeLocationService();
    await svc.createLocation(TEST_ORG_ID, "Source", 1);
    const [source] = await svc.listLocations(TEST_ORG_ID);
    await expect(svc.reassignLocation(source.id, 9999, TEST_ORG_ID, 1)).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

// ── InventoryService ──────────────────────────────────────────────────────────

describeDb("InventoryService", () => {
  it("creates an org item and logs the initial quantities", async () => {
    const svc = makeInventoryService();
    const item = await svc.createItem(
      TEST_ORG_ID,
      { gtin13: "1000000000001", existingQuantity: 10, desiredQuantity: 20 },
      1,
    );
    expect(item).not.toBeNull();
    expect(item?.existingQuantity).toBe(10);
    expect(item?.desiredQuantity).toBe(20);
  });

  it("throws 409 creating a duplicate org item", async () => {
    const svc = makeInventoryService();
    await svc.createItem(TEST_ORG_ID, { gtin13: "1000000000002" }, 1);
    await expect(svc.createItem(TEST_ORG_ID, { gtin13: "1000000000002" }, 1)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("same gtin13 in different orgs is allowed", async () => {
    const svc = makeInventoryService();
    await svc.createItem(TEST_ORG_ID, { gtin13: "1000000000003" }, 1);
    const item2 = await svc.createItem(TEST_ORG_ID_2, { gtin13: "1000000000003" }, 2);
    expect(item2?.orgId).toBe(TEST_ORG_ID_2);
  });

  it("updates existing quantity and logs the change", async () => {
    const svc = makeInventoryService();
    await svc.createItem(TEST_ORG_ID, { gtin13: "1000000000004", existingQuantity: 5 }, 1);
    const updated = await svc.updateItem(TEST_ORG_ID, "1000000000004", { existingQuantity: 15 }, 1);
    expect(updated?.existingQuantity).toBe(15);
  });

  it("throws 404 updating a non-existent item", async () => {
    const svc = makeInventoryService();
    await expect(svc.updateItem(TEST_ORG_ID, "9999999999999", { existingQuantity: 1 }, 1)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("deletes an org item", async () => {
    const svc = makeInventoryService();
    await svc.createItem(TEST_ORG_ID, { gtin13: "1000000000005" }, 1);
    await svc.deleteItem(TEST_ORG_ID, "1000000000005");
    expect(await svc.getItem(TEST_ORG_ID, "1000000000005")).toBeNull();
  });

  it("throws 404 deleting a non-existent item", async () => {
    const svc = makeInventoryService();
    await expect(svc.deleteItem(TEST_ORG_ID, "9999999999998")).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("applyQtyChange creates item if not present", async () => {
    const svc = makeInventoryService();
    const newQty = await svc.applyQtyChange(TEST_ORG_ID, "1000000000006", 7, {
      userId: 1,
      changeType: "received",
      receiptId: "r-001",
    });
    expect(newQty).toBe(7);
    const item = await svc.getItem(TEST_ORG_ID, "1000000000006");
    expect(item?.existingQuantity).toBe(7);
  });

  it("applyQtyChange accumulates on existing item", async () => {
    const svc = makeInventoryService();
    await svc.createItem(TEST_ORG_ID, { gtin13: "1000000000007", existingQuantity: 10 }, 1);
    const newQty = await svc.applyQtyChange(TEST_ORG_ID, "1000000000007", 5, {
      userId: null,
      changeType: "automatic",
      receiptId: null,
    });
    expect(newQty).toBe(15);
  });
});

// ── ReceiveQueueService ───────────────────────────────────────────────────────

describeDb("ReceiveQueueService", () => {
  async function seedQueueItem(orgId = TEST_ORG_ID, fulfilled = false) {
    const repo = createReceiveQueueRepository(db);
    return repo.create({
      orgId,
      gtin13: `rq-${Date.now()}-${Math.random()}`,
      quantity: 3,
      receiptId: `receipt-${Date.now()}`,
      lineItemId: 1,
      queuedAt: new Date(),
      fulfilledAt: fulfilled ? new Date() : null,
    });
  }

  it("listQueue excludes fulfilled items by default", async () => {
    const svc = makeReceiveQueueService();
    await seedQueueItem(TEST_ORG_ID, false);
    await seedQueueItem(TEST_ORG_ID, true);
    const list = await svc.listQueue(TEST_ORG_ID);
    expect(list.every((i) => i.fulfilledAt === null)).toBe(true);
    expect(list).toHaveLength(1);
  });

  it("listQueue includes fulfilled when flag set", async () => {
    const svc = makeReceiveQueueService();
    await seedQueueItem(TEST_ORG_ID, false);
    await seedQueueItem(TEST_ORG_ID, true);
    const list = await svc.listQueue(TEST_ORG_ID, true);
    expect(list).toHaveLength(2);
  });

  it("fulfill marks item fulfilled and updates inventory", async () => {
    const svc = makeReceiveQueueService();
    const item = await seedQueueItem();
    const fulfilled = await svc.fulfill(item.id, TEST_ORG_ID, 1);
    expect(fulfilled.fulfilledAt).not.toBeNull();

    const invSvc = makeInventoryService();
    const invItem = await invSvc.getItem(TEST_ORG_ID, item.gtin13);
    expect(invItem?.existingQuantity).toBe(item.quantity);
  });

  it("throws 409 fulfilling an already-fulfilled item", async () => {
    const svc = makeReceiveQueueService();
    const item = await seedQueueItem(TEST_ORG_ID, true);
    await expect(svc.fulfill(item.id, TEST_ORG_ID, 1)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("throws 404 fulfilling an item from another org", async () => {
    const svc = makeReceiveQueueService();
    const item = await seedQueueItem(TEST_ORG_ID_2);
    await expect(svc.fulfill(item.id, TEST_ORG_ID, 1)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("cancel removes an unfulfilled item", async () => {
    const svc = makeReceiveQueueService();
    const item = await seedQueueItem();
    await svc.cancel(item.id, TEST_ORG_ID);
    const list = await svc.listQueue(TEST_ORG_ID, true);
    expect(list.find((i) => i.id === item.id)).toBeUndefined();
  });

  it("throws 409 cancelling a fulfilled item", async () => {
    const svc = makeReceiveQueueService();
    const item = await seedQueueItem(TEST_ORG_ID, true);
    await expect(svc.cancel(item.id, TEST_ORG_ID)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("throws 404 cancelling a non-existent item", async () => {
    const svc = makeReceiveQueueService();
    await expect(svc.cancel(9999, TEST_ORG_ID)).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
