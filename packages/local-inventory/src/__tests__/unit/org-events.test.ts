/**
 * S5 consumer: the post-commit handler records each event in the ledger once, and the catch-up
 * sweep re-reads behind the cursor so an event that committed after a higher id is not skipped.
 * Real Postgres; describeDb skips without one.
 */
import { beforeEach, expect, it } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../lib/db/index";
import type { CatalogEventSource, OrgEventRecord } from "../../contract";
import { configureLocalInventory } from "../../runtime";
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

function configure(catalogEventSource?: CatalogEventSource) {
  configureLocalInventory({
    auth: { getPrincipal: async () => null },
    org: async () => ({ id: TEST_ORG_ID, name: "Org One" }),
    catalogEventSource,
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
});

describeDb("S5 catch-up", () => {
  it("is a no-op with the inert event source", async () => {
    expect(await catchUpOrgEvents()).toEqual({ processed: 0, duplicate: 0, failed: 0, skipped: 0 });
  });

  it("consumes an event that committed after a higher id was already received", async () => {
    // Event 21 committed and was consumed first; event 20 committed after it.
    await orgEventConsumer.onOrgEvents([rejected(21)]);
    configure({ eventsSince: async (_org, after) => [approved(20), rejected(21)].filter((e) => e.id > after) });

    expect(await catchUpOrgEvents()).toEqual({ processed: 1, duplicate: 0, failed: 0, skipped: 0 });

    expect(await resolution(PROV)).toMatchObject({ realGtin13: REAL });
    expect(await db.inventoryReceivedOrgEvent.count({ where: { status: "processed" } })).toBe(2);
  });
});
