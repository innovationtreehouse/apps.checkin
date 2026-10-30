/**
 * S5 consumer: the post-commit handler records each event in the ledger once, and the catch-up
 * sweep reads every catalog event not yet in the ledger, whatever ids have been received since.
 * Real Postgres; describeDb skips without one.
 */
import { beforeEach, expect, it, vi } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../lib/db/index";
import type { CatalogEventSource, InventoryAlerts, OrgEventRecord } from "../../contract";
import { configureLocalInventory, getServices } from "../../runtime";
import { catchUpOrgEvents, orgEventConsumer } from "../../lib/services/orgEventConsumer";
import { setupIntegrationDb } from "../helpers/setup";
import { TEST_ORG_ID, TEST_ORG_ID_2 } from "../helpers/seed";

setupIntegrationDb();

const PROV = "2000000000015";
const PROV_2 = "2000000000022";
const REAL = "0000000000017";

function event(id: number, eventType: string, body: Record<string, unknown>, orgId = TEST_ORG_ID): OrgEventRecord {
  return { id, orgId, eventType, payload: JSON.stringify({ version: 1, ...body }), createdAt: new Date() };
}
const approved = (id: number, orgId?: string) =>
  event(id, "provisional_approved", { provisionalGtin13: PROV, realGtin13: REAL, name: "Widget" }, orgId);
const rejected = (id: number) => event(id, "provisional_rejected", { provisionalGtin13: PROV_2, rejectionReason: "dup" });

function configure(catalogEventSource?: CatalogEventSource, alerts?: InventoryAlerts) {
  configureLocalInventory({
    auth: { getPrincipal: async () => null },
    org: async () => ({ id: TEST_ORG_ID, name: "Org One" }),
    catalogEventSource,
    alerts,
  });
}

const resolution = (gtin: string) => db.inventoryProvisionalResolution.findFirst({ where: { orgId: TEST_ORG_ID, provisionalGtin13: gtin } });

beforeEach(() => configure());

describeDb("S5 handler", () => {
  it("records a resolution and a processed ledger row, once", async () => {
    await orgEventConsumer.onOrgEvents([approved(5)]);
    await orgEventConsumer.onOrgEvents([approved(5)]);

    expect(await resolution(PROV)).toMatchObject({ realGtin13: REAL });
    expect(await db.inventoryReceivedOrgEvent.findMany()).toMatchObject([{ id: 5, status: "processed" }]);
  });

  it("records a payload that breaks the contract as failed, and catch-up retries it", async () => {
    await orgEventConsumer.onOrgEvents([event(6, "provisional_approved", { provisionalGtin13: PROV, realGtin13: 123 })]);
    expect(await db.inventoryReceivedOrgEvent.findFirst({ where: { id: 6 } })).toMatchObject({ status: "failed" });

    expect(await catchUpOrgEvents()).toMatchObject({ failed: 1, processed: 0 });
  });

  it("skips an event for another org without recording it", async () => {
    await orgEventConsumer.onOrgEvents([approved(7, TEST_ORG_ID_2)]);
    expect(await db.inventoryReceivedOrgEvent.count()).toBe(0);
  });

  it("keeps a processed row processed when an overlapping consumer's reaction fails", async () => {
    const service = getServices().provisionalItemService;
    const spy = vi.spyOn(service, "rejectProvisional").mockImplementationOnce(async () => {
      await orgEventConsumer.onOrgEvents([rejected(9)]);
      throw new Error("Provisional item was already resolved");
    });

    try {
      await orgEventConsumer.onOrgEvents([rejected(9)]);
    } finally {
      spy.mockRestore();
    }

    expect(await db.inventoryReceivedOrgEvent.findFirst({ where: { id: 9 } })).toMatchObject({ status: "processed", failureReason: null });
  });
});

describeDb("S5 catch-up", () => {
  it("is a no-op with the inert event source", async () => {
    expect(await catchUpOrgEvents()).toEqual({ processed: 0, duplicate: 0, failed: 0, skipped: 0, reconciled: 0, reconcileFailed: 0, unprocessed: 0, unreadable: false });
  });

  it("consumes an event that committed after a higher id was already received", async () => {
    // Event 21 committed and was consumed first; event 20 committed after it.
    await orgEventConsumer.onOrgEvents([rejected(21)]);
    configure({ eventsSince: async (_org, after) => [approved(20), rejected(21)].filter((e) => e.id > after) });

    expect(await catchUpOrgEvents()).toEqual({ processed: 1, duplicate: 0, failed: 0, skipped: 0, reconciled: 0, reconcileFailed: 0, unprocessed: 0, unreadable: false });

    expect(await resolution(PROV)).toMatchObject({ realGtin13: REAL });
    expect(await db.inventoryReceivedOrgEvent.count({ where: { status: "processed" } })).toBe(2);
  });
});

/** Serves `events` a page at a time, oldest first, as the catalog's replay read does. */
function pagedSource(events: OrgEventRecord[], pageSize = 2): CatalogEventSource {
  return { eventsSince: async (_org, after) => events.filter((e) => e.id > after).slice(0, pageSize) };
}

describeDb("S5 catch-up: a verdict far behind the newest received id", () => {
  it("applies it however many later ids were received, across pages", async () => {
    await db.inventoryProvisionalItem.create({
      data: { provisionalGtin13: PROV, name: "Widget", usageBehavior: "Unknown", orgId: TEST_ORG_ID, status: "pending" },
    });
    await orgEventConsumer.onOrgEvents([rejected(1000)]);
    const later = Array.from({ length: 5 }, (_, i) => rejected(900 + i));
    configure(pagedSource([approved(5), ...later, rejected(1000)]));

    await catchUpOrgEvents();

    expect(await db.inventoryProvisionalItem.findFirst({ where: { provisionalGtin13: PROV } })).toMatchObject({ status: "approved", resolvedToGtin13: REAL });
  });
});

describeDb("S5 catch-up: first run over an empty ledger", () => {
  const P_APPROVED = "2000000000039";
  const P_MAPPED_RESOLVED = "2000000000046";
  const P_MAPPED_OPEN = "2000000000053";
  const P_REJECTED = "2000000000060";
  const REAL_2 = "0000000000024";
  const REAL_3 = "0000000000031";

  const state = async () => ({
    items: await db.orgItem.findMany({ orderBy: { gtin13: "asc" } }),
    provisionals: await db.inventoryProvisionalItem.findMany({ orderBy: { id: "asc" } }),
    conflicts: await db.inventoryMergeConflict.findMany({ orderBy: { id: "asc" } }),
    inventoryLog: await db.inventoryLog.count(),
    provisionalLog: await db.provisionalItemLog.count(),
  });

  it("changes no stock and no status, and raises no alert", async () => {
    const reviewed = (provisionalGtin13: string, status: string, resolvedToGtin13: string | null) => ({
      provisionalGtin13, name: "Widget", usageBehavior: "Unknown", orgId: TEST_ORG_ID, status, resolvedToGtin13,
    });
    await db.inventoryProvisionalItem.createMany({
      data: [
        reviewed(P_APPROVED, "approved", REAL),
        reviewed(P_MAPPED_RESOLVED, "mapped_to_existing", REAL_2),
        reviewed(P_MAPPED_OPEN, "mapped_to_existing", REAL_3),
        reviewed(P_REJECTED, "rejected", null),
      ],
    });
    await db.orgItem.createMany({
      data: [
        { orgId: TEST_ORG_ID, gtin13: REAL, existingQuantity: 5 },
        { orgId: TEST_ORG_ID, gtin13: REAL_2, existingQuantity: 7 },
        { orgId: TEST_ORG_ID, gtin13: REAL_3, existingQuantity: 6 },
        { orgId: TEST_ORG_ID, gtin13: P_MAPPED_OPEN, existingQuantity: 4 },
        { orgId: TEST_ORG_ID, gtin13: P_REJECTED, existingQuantity: 2 },
      ],
    });
    await db.inventoryMergeConflict.createMany({
      data: [
        { orgId: TEST_ORG_ID, provisionalGtin13: P_MAPPED_RESOLVED, realGtin13: REAL_2, conflictType: "uom_mismatch", sourceEventId: 2, status: "resolved" },
        { orgId: TEST_ORG_ID, provisionalGtin13: P_MAPPED_OPEN, realGtin13: REAL_3, conflictType: "uom_mismatch", sourceEventId: 3 },
      ],
    });
    const before = await state();
    const orgEventsStuck = vi.fn(async () => {});
    const mapped = (id: number, provisionalGtin13: string, realGtin13: string) =>
      event(id, "provisional_mapped_to_existing", { provisionalGtin13, realGtin13, conversionFactor: 12 });
    configure(
      pagedSource([
        event(1, "provisional_approved", { provisionalGtin13: P_APPROVED, realGtin13: REAL, name: "Widget", conversionFactor: 12 }),
        mapped(2, P_MAPPED_RESOLVED, REAL_2),
        mapped(3, P_MAPPED_OPEN, REAL_3),
        event(4, "provisional_rejected", { provisionalGtin13: P_REJECTED, rejectionReason: "dup" }),
      ]),
      { orgEventsStuck },
    );

    expect(await catchUpOrgEvents()).toMatchObject({ processed: 4, failed: 0, reconciled: 0 });

    expect(await state()).toEqual(before);
    expect(orgEventsStuck).not.toHaveBeenCalled();
  });
});

describeDb("S5 catch-up: alerts", () => {
  const malformed = (id: number) => event(id, "provisional_approved", { provisionalGtin13: PROV, realGtin13: 123 });

  it("alerts once when the catalog can't be read, and still reconciles", async () => {
    const orgEventsStuck = vi.fn(async () => {});
    await orgEventConsumer.onOrgEvents([approved(5)]);
    await db.inventoryProvisionalItem.create({
      data: { provisionalGtin13: PROV, name: "Widget", usageBehavior: "Unknown", orgId: TEST_ORG_ID, status: "pending" },
    });
    configure({ eventsSince: async () => { throw new Error("catalog down"); } }, { orgEventsStuck });

    expect(await catchUpOrgEvents()).toMatchObject({ unreadable: true, reconciled: 1 });
    expect(orgEventsStuck).toHaveBeenCalledTimes(1);
    expect(orgEventsStuck).toHaveBeenCalledWith({ failed: 0, unprocessed: 0, unreadable: true });
  });

  it("alerts once for events that fail or don't fit this run, and leaves them for the next", async () => {
    const orgEventsStuck = vi.fn(async () => {});
    configure(pagedSource([malformed(1), malformed(2), rejected(3)]), { orgEventsStuck });

    expect(await catchUpOrgEvents(2)).toMatchObject({ failed: 2, unprocessed: 1 });
    expect(orgEventsStuck).toHaveBeenCalledTimes(1);
    expect(orgEventsStuck).toHaveBeenCalledWith({ failed: 2, unprocessed: 1, unreadable: false });
    expect(await db.inventoryReceivedOrgEvent.count({ where: { id: 3 } })).toBe(0);
  });

  it("finishes the run when the alert itself throws", async () => {
    configure(pagedSource([malformed(1)]), { orgEventsStuck: async () => { throw new Error("mail down"); } });
    expect(await catchUpOrgEvents()).toMatchObject({ failed: 1 });
  });

  it("finishes the sweep when a ledger write throws", async () => {
    const spy = vi.spyOn(db.inventoryReceivedOrgEvent, "createMany").mockRejectedValueOnce(new Error("db blip"));
    configure(pagedSource([rejected(1), rejected(2)]));
    try {
      expect(await catchUpOrgEvents()).toMatchObject({ failed: 1, processed: 1 });
    } finally {
      spy.mockRestore();
    }
  });
});

describeDb("S5 catch-up: stored resolutions", () => {
  async function pendingProvisionalWithStock(quantity: number) {
    await db.inventoryProvisionalItem.create({
      data: { provisionalGtin13: PROV, name: "Widget", usageBehavior: "Unknown", orgId: TEST_ORG_ID, status: "pending" },
    });
    await db.orgItem.create({ data: { orgId: TEST_ORG_ID, gtin13: PROV, existingQuantity: quantity, desiredQuantity: 0 } });
  }
  const qty = async (gtin13: string) =>
    (await db.orgItem.findFirst({ where: { orgId: TEST_ORG_ID, gtin13 } }))?.existingQuantity ?? null;

  it("merges a pending provisional whose resolution arrived before it, once", async () => {
    // The resolution is stored with no provisional row; the reconcile after the creating commit never ran.
    await orgEventConsumer.onOrgEvents([approved(5)]);
    await pendingProvisionalWithStock(3);

    expect(await catchUpOrgEvents()).toMatchObject({ reconciled: 1 });
    expect(await db.inventoryProvisionalItem.findFirst({ where: { provisionalGtin13: PROV } })).toMatchObject({
      status: "approved",
      resolvedToGtin13: REAL,
    });
    expect(await qty(REAL)).toBe(3);
    expect(await qty(PROV)).toBeNull();

    expect(await catchUpOrgEvents()).toMatchObject({ reconciled: 0 });
    expect(await qty(REAL)).toBe(3);
  });

  it("leaves a pending provisional with no resolution alone", async () => {
    await pendingProvisionalWithStock(2);

    expect(await catchUpOrgEvents()).toMatchObject({ reconciled: 0 });
    expect(await db.inventoryProvisionalItem.findFirst({ where: { provisionalGtin13: PROV } })).toMatchObject({ status: "pending" });
    expect(await qty(PROV)).toBe(2);
  });

  it("counts a reconcile that throws as failed, and the next run applies it", async () => {
    await orgEventConsumer.onOrgEvents([approved(5)]);
    await pendingProvisionalWithStock(3);
    const spy = vi.spyOn(getServices().provisionalItemService, "reconcileProvisionalOnCreate").mockRejectedValueOnce(new Error("boom"));

    try {
      expect(await catchUpOrgEvents()).toMatchObject({ reconciled: 0, reconcileFailed: 1 });
      expect(await db.inventoryProvisionalItem.findFirst({ where: { provisionalGtin13: PROV } })).toMatchObject({ status: "pending" });

      expect(await catchUpOrgEvents()).toMatchObject({ reconciled: 1, reconcileFailed: 0 });
      expect(await qty(REAL)).toBe(3);
    } finally {
      spy.mockRestore();
    }
  });
});
