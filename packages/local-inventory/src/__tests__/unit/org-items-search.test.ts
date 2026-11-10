/** The org-items search finds items by catalog name and provisional name, and the count matches the rows. Real Postgres; describeDb skips without one. */
import { beforeEach, expect, it, vi } from "vitest";
import { buildProvisionalGtin13 } from "@checkin/gtin";
import { describeDb } from "../helpers/db";
import { db } from "../../lib/db/index";
import { count, list } from "../../routes/orgItems";
import { configureLocalInventory } from "../../runtime";
import type { CatalogItemReader } from "../../contract";
import { setupIntegrationDb } from "../helpers/setup";
import { TEST_ORG_ID, TEST_ORG_ID_2 } from "../helpers/seed";

setupIntegrationDb();

const DRILL = "4006381333931";
const HAMMER = "0044444444447";
const PROVISIONAL = buildProvisionalGtin13(123);

const catalogNames: Record<string, string> = { [DRILL]: "Cordless Drill", [HAMMER]: "Claw Hammer" };
const catalog: CatalogItemReader = {
  getActiveItem: async () => null,
  searchItems: async (query, take) =>
    Object.entries(catalogNames)
      .filter(([, name]) => name.toLowerCase().includes(query.toLowerCase()))
      .slice(0, take)
      .map(([gtin13]) => ({ gtin13 })),
};

function configure(reader: CatalogItemReader = catalog) {
  configureLocalInventory({
    auth: { getPrincipal: async () => ({ id: 1, name: "Manager" }) },
    org: async () => ({ id: TEST_ORG_ID, name: "Org One" }),
    catalog: reader,
  });
}

async function search(q: string) {
  const url = `http://test/api/inventory/org-items?q=${encodeURIComponent(q)}`;
  const rows = await list({ req: new Request(url), params: {} });
  const total = await count({ req: new Request(url), params: {} });
  return { gtins: (rows.OrgItem as { gtin13: string }[]).map((i) => i.gtin13).sort(), total: (total.InventoryCount as { total: number }).total };
}

describeDb("org-items search by name", () => {
  beforeEach(async () => {
    configure();
    await db.orgItem.createMany({
      data: [
        { orgId: TEST_ORG_ID, gtin13: DRILL },
        { orgId: TEST_ORG_ID, gtin13: HAMMER },
        { orgId: TEST_ORG_ID, gtin13: PROVISIONAL },
        { orgId: TEST_ORG_ID_2, gtin13: DRILL },
      ],
    });
    await db.inventoryProvisionalItem.create({
      data: { orgId: TEST_ORG_ID, provisionalGtin13: PROVISIONAL, name: "Brass Hinge", usageBehavior: "consumable", status: "pending" },
    });
  });

  it("finds an item by its catalog name in any case, with a count matching the rows", async () => {
    expect(await search("drill")).toEqual({ gtins: [DRILL], total: 1 });
  });

  it("finds a provisional part by its name", async () => {
    expect(await search("HINGE")).toEqual({ gtins: [PROVISIONAL], total: 1 });
  });

  it("matches nothing for a name no item has", async () => {
    expect(await search("sprocket")).toEqual({ gtins: [], total: 0 });
  });

  it("falls back to GTIN and provisional names when the catalog search fails, logging it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    configure({ ...catalog, searchItems: async () => { throw new Error("catalog down"); } });
    expect(await search("drill")).toEqual({ gtins: [], total: 0 });
    expect(await search("hinge")).toEqual({ gtins: [PROVISIONAL], total: 1 });
    expect(await search("0044444")).toEqual({ gtins: [HAMMER], total: 1 });
    expect(error).toHaveBeenCalledWith("[local-inventory] catalog name search failed", expect.any(Error));
    error.mockRestore();
  });
});
