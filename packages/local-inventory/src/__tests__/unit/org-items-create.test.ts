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

/** A NotWiredError from a second copy of component-kit, as a built app can load: the kit's brand and name, another class. */
const foreignNotWired = (port: string) =>
  Object.assign(new Error(`${port} is not wired`), { name: "NotWiredError", kind: "settings", [Symbol.for("@checkin/component-kit/KindedError")]: true, [Symbol.for("@checkin/component-kit/NotWiredError")]: true });

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
    await expect(post(PROVISIONAL)).rejects.toMatchObject({ status: 400, message: "No active catalog item or pending provisional part has GTIN P000123" });
  });

  it("answers 502 and adds nothing when the catalog can't be reached", async () => {
    configureLocalInventory({
      auth: { getPrincipal: async () => ({ id: 1, name: "Manager" }) },
      org: async () => ({ id: TEST_ORG_ID, name: "Org One" }),
      catalog: { getActiveItem: async () => { throw new Error("catalog down"); } },
    });
    await expect(post(CATALOG_GTIN)).rejects.toMatchObject({ status: 502 });
    expect(await db.orgItem.count()).toBe(0);
  });

  it("answers 503 \"No catalog is connected\" when the host bound no catalog, rather than calling the part unknown", async () => {
    configureLocalInventory({
      auth: { getPrincipal: async () => ({ id: 1, name: "Manager" }) },
      org: async () => ({ id: TEST_ORG_ID, name: "Org One" }),
    });
    await expect(post(CATALOG_GTIN)).rejects.toMatchObject({ status: 503, message: "No catalog is connected" });
    expect(await db.orgItem.count()).toBe(0);
  });

  it("answers 503 \"No catalog is connected\" for an unbound catalog from another copy of the kit", async () => {
    configureLocalInventory({
      auth: { getPrincipal: async () => ({ id: 1, name: "Manager" }) },
      org: async () => ({ id: TEST_ORG_ID, name: "Org One" }),
      catalog: { getActiveItem: async () => { throw foreignNotWired("catalog.getActiveItem"); } },
    });
    await expect(post(CATALOG_GTIN)).rejects.toMatchObject({ status: 503, message: "No catalog is connected" });
    expect(await db.orgItem.count()).toBe(0);
  });

  it("answers 503 naming who fixes it when the catalog database does not exist, adding nothing", async () => {
    configureLocalInventory({
      auth: { getPrincipal: async () => ({ id: 1, name: "Manager" }) },
      org: async () => ({ id: TEST_ORG_ID, name: "Org One" }),
      catalog: { getActiveItem: async () => { throw Object.assign(new Error("Database does not exist"), { code: "P1003" }); } },
    });
    await expect(post(CATALOG_GTIN)).rejects.toMatchObject({ status: 503, message: "The catalog database does not exist; the infra operator checks its settings" });
    expect(await db.orgItem.count()).toBe(0);
  });

  it("refuses a wrong check digit and a GTIN that is no active catalog item, adding nothing", async () => {
    await expect(post("4006381333932")).rejects.toMatchObject({ status: 400 });
    await expect(post("0012345678905")).rejects.toMatchObject({ status: 400 });
    expect(await db.orgItem.count()).toBe(0);
  });
});
