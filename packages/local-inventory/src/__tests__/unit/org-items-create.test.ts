/** Adding an org item takes only a checked GTIN-13 of an active catalog item or a pending provisional part of the org. Real Postgres; describeDb skips without one. */
import { beforeEach, expect, it } from "vitest";
import { buildProvisionalGtin13 } from "@checkin/gtin";
import { describeDb } from "../helpers/db";
import { db } from "../../lib/db/index";
import { create } from "../../routes/orgItems";
import { configureLocalInventory } from "../../runtime";
import { setupIntegrationDb } from "../helpers/setup";
import { TEST_ORG_ID, TEST_ORG_ID_2 } from "../helpers/seed";

setupIntegrationDb();

const CATALOG_GTIN = "4006381333931";
const PROVISIONAL = buildProvisionalGtin13(123);

const post = (gtin13: string) =>
  create({ req: new Request("http://test/api/inventory/org-items", { method: "POST", body: JSON.stringify({ gtin13 }) }), params: {} });

function provisional(gtin13: string, status: string, { orgId = TEST_ORG_ID, resolvedToGtin13 = null as string | null } = {}) {
  return db.inventoryProvisionalItem.create({ data: { orgId, provisionalGtin13: gtin13, name: "Widget", usageBehavior: "consumable", status, resolvedToGtin13 } });
}

describeDb("POST org-items", () => {
  beforeEach(() => {
    configureLocalInventory({
      auth: { getPrincipal: async () => ({ id: 1, name: "Manager" }) },
      org: async () => ({ id: TEST_ORG_ID, name: "Org One" }),
      catalog: { getActiveItem: async (gtin13: string) => (gtin13 === CATALOG_GTIN ? { gtin13 } : null) },
    });
  });

  it("adds a catalog item", async () => {
    expect(await post(CATALOG_GTIN)).toMatchObject({ OrgItem: { gtin13: CATALOG_GTIN } });
  });

  it("adds a pending provisional part of the org", async () => {
    await provisional(PROVISIONAL, "pending");
    expect(await post(PROVISIONAL)).toMatchObject({ OrgItem: { gtin13: PROVISIONAL } });
  });

  it.each(["approved", "mapped_to_existing"])("refuses a %s provisional part, naming the real part it became", async (status) => {
    await provisional(PROVISIONAL, status, { resolvedToGtin13: CATALOG_GTIN });
    await expect(post(PROVISIONAL)).rejects.toMatchObject({ status: 400, message: `P000123 is now ${CATALOG_GTIN}; pick that part instead` });
  });

  it("refuses a rejected provisional part", async () => {
    await provisional(PROVISIONAL, "rejected");
    await expect(post(PROVISIONAL)).rejects.toMatchObject({ status: 400, message: "P000123 was rejected by the catalog" });
  });

  it("refuses another org's provisional part", async () => {
    await provisional(PROVISIONAL, "pending", { orgId: TEST_ORG_ID_2 });
    await expect(post(PROVISIONAL)).rejects.toMatchObject({ status: 400 });
  });

  it("refuses a wrong check digit and a GTIN that is no active catalog item, adding nothing", async () => {
    await expect(post("4006381333932")).rejects.toMatchObject({ status: 400 });
    await expect(post("0012345678905")).rejects.toMatchObject({ status: 400 });
    expect(await db.orgItem.count()).toBe(0);
  });
});
