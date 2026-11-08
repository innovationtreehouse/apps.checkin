/** The Problems list's ports: inventory deltas and catalog events that failed to apply, timed by their first failure, and their retry. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { inertCatalogEventSource, type OrgEventRecord } from "../../contract";
import { db } from "../../lib/db/index";
import { catchUpOrgEvents, orgEventConsumer } from "../../lib/services/orgEventConsumer";
import { configureLocalInventory, getServices } from "../../runtime";
import { retryStuckItem, stuckItems } from "../../stuckItems";
import { describeDb } from "../helpers/db";
import { TEST_ORG_ID, TEST_ORG_ID_2 } from "../helpers/seed";
import { setupIntegrationDb } from "../helpers/setup";

setupIntegrationDb();

const GTIN = "0000000000017";
const PROV = "2000000000015";
const REAL = "0000000000017";
// 3e9 overflows the INTEGER quantity column, so the apply fails.
const OVERFLOW = 3_000_000_000;

beforeEach(() =>
  configureLocalInventory({
    auth: { getPrincipal: async () => null },
    org: async () => ({ id: TEST_ORG_ID, name: "Org One" }),
    catalogEventSource: inertCatalogEventSource,
  }),
);
afterEach(() => vi.restoreAllMocks());

const qty = async (gtin13 = GTIN) => (await db.orgItem.findFirst({ where: { orgId: TEST_ORG_ID, gtin13 } }))?.existingQuantity ?? 0;
const tick = () => new Promise((r) => setTimeout(r, 5));
const malformed = (id: number): OrgEventRecord => ({
  id, orgId: TEST_ORG_ID, eventType: "provisional_approved", payload: JSON.stringify({ version: 1, provisionalGtin13: PROV, realGtin13: 123 }), createdAt: new Date(),
});

/** A failed delta row as an apply records it: canonical delta JSON, defaults filled in. */
function failedDelta(sourceKey: string, receiptId: string | null, source: Record<string, unknown>, lines: { gtin13: string; quantityDelta: number; isDelayed?: boolean; lineItemId?: number }[]) {
  const src = source.kind === "receipt" ? { kind: "receipt", receiptId: source.receiptId, retailer: source.retailer ?? null } : source;
  const lineItems = lines.map((li) => ({
    gtin13: li.gtin13, quantityDelta: li.quantityDelta, isDelayed: li.isDelayed ?? false, lineItemId: li.lineItemId ?? null,
    isProvisional: false, provisionalName: null, conversionFactor: 1, conversionVersion: 1,
  }));
  return db.receivedInventoryDelta.create({
    data: { orgId: TEST_ORG_ID, sourceKey, receiptId, deltaJson: JSON.stringify({ source: src, lineItems }), status: "failed", failureReason: "boom", firstFailedAt: new Date() },
  });
}

describeDb("stuckItems", () => {
  it("lists failed deltas, with the receipt's page when it has one, and failed catalog events, timed by their first failure", async () => {
    const at = new Date("2026-11-01T10:00:00Z");
    const first = new Date("2026-11-02T10:00:00Z");
    const delta = (orgId: string, sourceKey: string, status: string, receiptId: string | null, firstFailedAt: Date | null = first) =>
      db.receivedInventoryDelta.create({ data: { orgId, sourceKey, receiptId, deltaJson: "{}", status, failureReason: "boom", receivedAt: at, firstFailedAt } });
    await delta(TEST_ORG_ID, "receipt:r1", "failed", "r1");
    const donation = await delta(TEST_ORG_ID, "donation:d1", "failed", null);
    await delta(TEST_ORG_ID, "receipt:r4", "failed", "r4", null);
    await delta(TEST_ORG_ID, "receipt:r2", "applied", "r2", null);
    await delta(TEST_ORG_ID_2, "receipt:r3", "failed", "r3");
    const event = await db.inventoryReceivedOrgEvent.create({ data: { orgId: TEST_ORG_ID, eventType: "item_reviewed", payload: "{}", receivedAt: at, status: "failed", failureReason: "boom", firstFailedAt: first } });
    await db.inventoryReceivedOrgEvent.create({ data: { orgId: TEST_ORG_ID, eventType: "item_reviewed", payload: "{}", receivedAt: at, status: "processed" } });

    expect(await stuckItems()).toEqual([
      { id: "r1", step: "inventory delta", href: "/receipts/r1", failedAt: first },
      { id: String(donation.id), step: "inventory delta", href: null, failedAt: first },
      { id: "r4", step: "inventory delta", href: "/receipts/r4", failedAt: at },
      { id: String(event.id), step: "catalog event", href: null, failedAt: first },
    ]);
  });

  it("carries no error text", async () => {
    await db.receivedInventoryDelta.create({ data: { orgId: TEST_ORG_ID, sourceKey: "receipt:r1", receiptId: "r1", deltaJson: "{}", status: "failed", failureReason: "secret detail", firstFailedAt: new Date() } });
    expect(JSON.stringify(await stuckItems())).not.toContain("secret detail");
  });

  it("a second failure of a delta does not move its time, and a success clears it", async () => {
    const receipts = getServices().receiptService;
    await expect(receipts.applyReceipt(TEST_ORG_ID, "r1", undefined, [{ gtin13: GTIN, quantityDelta: OVERFLOW }])).rejects.toThrow();
    const [before] = await stuckItems();

    await tick();
    await retryStuckItem({ id: before.id, step: before.step });
    await expect(receipts.applyReceipt(TEST_ORG_ID, "r1", undefined, [{ gtin13: GTIN, quantityDelta: OVERFLOW }])).rejects.toThrow();
    expect(await stuckItems()).toEqual([before]);

    await receipts.applyReceipt(TEST_ORG_ID, "r1", undefined, [{ gtin13: GTIN, quantityDelta: 2 }]);
    expect(await stuckItems()).toEqual([]);
    expect(await db.receivedInventoryDelta.findFirst()).toMatchObject({ status: "applied", failureReason: null, firstFailedAt: null });
  });

  it("a second failure of a catalog event does not move its time", async () => {
    await orgEventConsumer.onOrgEvents([malformed(5)]);
    const [before] = await stuckItems();

    await tick();
    await retryStuckItem({ id: before.id, step: before.step });
    await orgEventConsumer.onOrgEvents([malformed(5)]);

    expect(await stuckItems()).toEqual([before]);
  });
});

describeDb("stuckItems: provisionals", () => {
  const pending = (provisionalGtin13: string, extra: Record<string, unknown> = {}) =>
    db.inventoryProvisionalItem.create({ data: { provisionalGtin13, name: "Widget", usageBehavior: "Unknown", orgId: TEST_ORG_ID, status: "pending", ...extra } });

  it("lists a pending provisional whose catalog decision failed to apply, without its error", async () => {
    const first = new Date("2026-11-02T10:00:00Z");
    await pending(PROV, { reconcileFirstFailedAt: first, reconcileLastError: "secret detail" });
    await pending("2000000000022");
    await pending("2000000000039", { status: "approved", reconcileFirstFailedAt: first });

    const items = await stuckItems();
    expect(items).toEqual([{ id: PROV, step: "provisional item", href: "/inventory/provisional-items", failedAt: first }]);
    expect(JSON.stringify(items)).not.toContain("secret detail");
  });

  it("a failed retry keeps the first failure time; a retry that applies clears it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await orgEventConsumer.onOrgEvents([{ id: 5, orgId: TEST_ORG_ID, eventType: "provisional_approved", payload: JSON.stringify({ version: 1, provisionalGtin13: PROV, realGtin13: REAL, name: "Widget" }), createdAt: new Date() }]);
    await pending(PROV);
    const reconcile = vi.spyOn(getServices().provisionalItemService, "reconcileProvisionalOnCreate").mockRejectedValueOnce(new Error("boom")).mockRejectedValueOnce(new Error("again"));
    await catchUpOrgEvents();
    const [before] = await stuckItems();
    expect(before).toMatchObject({ id: PROV, step: "provisional item" });

    await tick();
    await retryStuckItem(before);
    expect(await stuckItems()).toEqual([before]);
    expect(await db.inventoryProvisionalItem.findFirst({ where: { provisionalGtin13: PROV } })).toMatchObject({ reconcileLastError: "again" });

    reconcile.mockRestore();
    await retryStuckItem(before);
    expect(await db.inventoryProvisionalItem.findFirst({ where: { provisionalGtin13: PROV } })).toMatchObject({ status: "approved", reconcileFirstFailedAt: null, reconcileLastError: null });
    await expect(retryStuckItem(before)).rejects.toMatchObject({ status: 404 });
  });
});

describeDb("retryStuckItem", () => {
  it("applies a failed receipt delta once from its stored lines", async () => {
    const lines = [{ gtin13: GTIN, quantityDelta: 3 }, { gtin13: "0000000000024", quantityDelta: 1, isDelayed: true, lineItemId: 4 }];
    await failedDelta("receipt:r1", "r1", { kind: "receipt", receiptId: "r1", retailer: "Costco" }, lines);
    const [item] = await stuckItems();
    expect(item).toMatchObject({ id: "r1", step: "inventory delta" });

    await retryStuckItem(item);
    await expect(retryStuckItem(item)).rejects.toMatchObject({ status: 404 });

    expect(await qty()).toBe(3);
    expect(await db.receiveQueue.count({ where: { receiptId: "r1", retailer: "Costco", lineItemId: 4 } })).toBe(1);
    expect(await stuckItems()).toEqual([]);
    // The receipt's own apply after the retry is a replay of the same delta.
    expect(await getServices().receiptService.applyReceipt(TEST_ORG_ID, "r1", "Costco", lines)).toMatchObject({ replayed: true });
  });

  it("applies a failed donation delta, found by its row id", async () => {
    const row = await failedDelta("donation:7", null, { kind: "donation", donationId: "7" }, [{ gtin13: GTIN, quantityDelta: 1 }]);
    const [item] = await stuckItems();
    expect(item).toMatchObject({ id: String(row.id), href: null });

    await retryStuckItem(item);

    expect(await qty()).toBe(1);
    expect(await stuckItems()).toEqual([]);
  });

  it("a retry that fails again leaves the delta stuck and does not throw its error", async () => {
    await expect(getServices().receiptService.applyReceipt(TEST_ORG_ID, "r1", undefined, [{ gtin13: GTIN, quantityDelta: OVERFLOW }])).rejects.toThrow();
    const [item] = await stuckItems();

    await expect(retryStuckItem(item)).resolves.toBeUndefined();

    expect(await stuckItems()).toEqual([item]);
  });

  it("applies a failed catalog event from its ledger row", async () => {
    await db.inventoryProvisionalItem.create({ data: { provisionalGtin13: PROV, name: "Widget", usageBehavior: "Unknown", orgId: TEST_ORG_ID, status: "pending" } });
    await db.inventoryReceivedOrgEvent.create({
      data: { id: 8, orgId: TEST_ORG_ID, eventType: "provisional_approved", payload: JSON.stringify({ version: 1, provisionalGtin13: PROV, realGtin13: REAL, name: "Widget" }), receivedAt: new Date(), status: "failed", failureReason: "boom", firstFailedAt: new Date() },
    });

    await retryStuckItem({ id: "8", step: "catalog event" });

    expect(await db.inventoryReceivedOrgEvent.findFirst({ where: { id: 8 } })).toMatchObject({ status: "processed", failureReason: null, firstFailedAt: null });
    expect(await db.inventoryProvisionalItem.findFirst({ where: { provisionalGtin13: PROV } })).toMatchObject({ status: "approved", resolvedToGtin13: REAL });
  });

  it("answers 404 for an item that is not stuck, another org's item, or an unknown step", async () => {
    await getServices().receiptService.applyReceipt(TEST_ORG_ID, "r1", undefined, [{ gtin13: GTIN, quantityDelta: 1 }]);
    await db.receivedInventoryDelta.create({ data: { orgId: TEST_ORG_ID_2, sourceKey: "receipt:r2", receiptId: "r2", deltaJson: "{}", status: "failed", firstFailedAt: new Date() } });
    await db.inventoryReceivedOrgEvent.create({ data: { id: 9, orgId: TEST_ORG_ID, eventType: "item_reviewed", payload: "{}", receivedAt: new Date(), status: "processed" } });

    await expect(retryStuckItem({ id: "r1", step: "inventory delta" })).rejects.toMatchObject({ status: 404 });
    await expect(retryStuckItem({ id: "r2", step: "inventory delta" })).rejects.toMatchObject({ status: 404 });
    await expect(retryStuckItem({ id: "9", step: "catalog event" })).rejects.toMatchObject({ status: 404 });
    await expect(retryStuckItem({ id: "x", step: "catalog event" })).rejects.toMatchObject({ status: 404 });
    await expect(retryStuckItem({ id: "r1", step: "nonsense" })).rejects.toMatchObject({ status: 404 });
  });
});
