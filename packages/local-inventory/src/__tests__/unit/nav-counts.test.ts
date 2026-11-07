/** The nav pill counts agree with the screens they lead to, for the current org only. Real Postgres; describeDb skips without one. */
import { expect, it } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../lib/db/index";
import { count as countItems } from "../../routes/orgItems";
import { configureLocalInventory, getNavCounts } from "../../runtime";
import { inertCatalogEventSource } from "../../contract";
import { setupIntegrationDb } from "../helpers/setup";
import { TEST_ORG_ID, TEST_ORG_ID_2 } from "../helpers/seed";

setupIntegrationDb();

function mergeConflict(orgId: string, sourceEventId: number, status: string) {
  return db.inventoryMergeConflict.create({
    data: { orgId, sourceEventId, status, provisionalGtin13: "0200000000011", realGtin13: "0000000000031", conflictType: "uom_mismatch" },
  });
}

describeDb("local-inventory nav counts", () => {
  it("count pending merge conflicts and unlocated items for the current org, matching the page's filter", async () => {
    configureLocalInventory({
      auth: { getPrincipal: async () => null },
      org: async () => ({ id: TEST_ORG_ID, name: "Org One" }),
      catalogEventSource: inertCatalogEventSource,
    });

    await mergeConflict(TEST_ORG_ID, 1, "pending");
    await mergeConflict(TEST_ORG_ID, 2, "resolved");
    await mergeConflict(TEST_ORG_ID_2, 3, "pending");

    const shelf = await db.location.create({ data: { orgId: TEST_ORG_ID, name: "Shelf" } });
    await db.orgItem.create({ data: { orgId: TEST_ORG_ID, gtin13: "0000000000031" } });
    await db.orgItem.create({ data: { orgId: TEST_ORG_ID, gtin13: "0000000000048" } });
    await db.orgItem.create({ data: { orgId: TEST_ORG_ID, gtin13: "0000000000055", locationId: shelf.id } });
    await db.orgItem.create({ data: { orgId: TEST_ORG_ID_2, gtin13: "0000000000031" } });

    const counts = await getNavCounts();

    expect(counts).toMatchObject({ pendingMergeConflicts: 1, unlocated: 2 });
    const page = await countItems({ req: new Request("http://test/?unlocated=true"), params: {} });
    expect(page).toEqual({ InventoryCount: { total: counts.unlocated } });
  });
});
