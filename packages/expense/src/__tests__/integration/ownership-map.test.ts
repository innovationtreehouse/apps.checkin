/** The part-bucket map names each mapped part from the catalog. */
import { expect, it, vi } from "vitest";
import { describeDb } from "../helpers/db";
import { bindPorts, catalogResolving, principal, ORG } from "../helpers/seed";
import { db } from "../../db";
import { finance } from "../../routes";

const NAMED = "0012345678905";
const UNNAMED = "0098765432109";
/** What the catalog client throws when its database cannot be reached. */
const catalogDown = () => Object.assign(new Error("Can't reach database server"), { code: "P1001" });

describeDb("GET ownership-map", () => {
  it("returns the catalog name of each mapped part on the page, and nothing for an unknown GTIN", async () => {
    const getItemNames = vi.fn(async (gtins: string[]) => [{ gtin13: NAMED, name: "Hex bolt M6" }].filter((i) => gtins.includes(i.gtin13)));
    bindPorts({ catalog: { ...catalogResolving({}), getItemNames } });
    await db.partOwnerMap.createMany({ data: [{ orgId: ORG, gtin13: NAMED, ownerId: 100 }, { orgId: ORG, gtin13: UNNAMED, ownerId: 100 }] });

    const res = await finance.ownershipMap({ req: new Request("http://test/api/expense/ownership-map"), params: {}, principal: principal(3, { isFinance: true }) });

    expect(getItemNames).toHaveBeenCalledWith([NAMED, UNNAMED]);
    expect(res).toMatchObject({
      PartOwnerMap: [{ gtin13: NAMED }, { gtin13: UNNAMED }],
      Item: [{ gtin13: NAMED, name: "Hex bolt M6" }],
    });
  });

  it("carries only each item's GTIN and name, whatever else the catalog returns", async () => {
    const fullRow = { gtin13: NAMED, name: "Hex bolt M6", categoryId: 1, subcategoryId: 10, createdByUserId: 9, createdByUsername: "jordan" };
    bindPorts({ catalog: { ...catalogResolving({}), getItemNames: async () => [fullRow] } });
    await db.partOwnerMap.create({ data: { orgId: ORG, gtin13: NAMED, ownerId: 100 } });

    const res = await finance.ownershipMap({ req: new Request("http://test/api/expense/ownership-map"), params: {}, principal: principal(3, { isFinance: true }) });

    expect(res.Item).toEqual([{ gtin13: NAMED, name: "Hex bolt M6" }]);
  });

  it("asks the catalog nothing when no part is mapped", async () => {
    const getItemNames = vi.fn(async () => []);
    bindPorts({ catalog: { ...catalogResolving({}), getItemNames } });

    expect(await finance.ownershipMap({ req: new Request("http://test/api/expense/ownership-map"), params: {}, principal: principal(3, { isFinance: true }) })).toMatchObject({ PartOwnerMap: [], Item: [] });
    expect(getItemNames).not.toHaveBeenCalled();
  });

  it("shows the map without names when no catalog is connected", async () => {
    await db.partOwnerMap.create({ data: { orgId: ORG, gtin13: NAMED, ownerId: 100 } });

    const res = await finance.ownershipMap({ req: new Request("http://test/api/expense/ownership-map"), params: {}, principal: principal(3, { isFinance: true }) });

    expect(res).toMatchObject({ PartOwnerMap: [{ gtin13: NAMED }], Item: [] });
  });

  it("shows the map without names when the catalog database is unreachable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await db.partOwnerMap.create({ data: { orgId: ORG, gtin13: NAMED, ownerId: 100 } });
    bindPorts({ catalog: { ...catalogResolving({}), getItemNames: async () => { throw catalogDown(); } } });

    const res = await finance.ownershipMap({ req: new Request("http://test/api/expense/ownership-map"), params: {}, principal: principal(3, { isFinance: true }) });

    expect(res).toMatchObject({ PartOwnerMap: [{ gtin13: NAMED }], Item: [] });
  });
  it("answers 503 naming who fixes it when the catalog database does not exist, not a map without names", async () => {
    await db.partOwnerMap.create({ data: { orgId: ORG, gtin13: NAMED, ownerId: 100 } });
    bindPorts({ catalog: { ...catalogResolving({}), getItemNames: async () => { throw Object.assign(new Error("Database does not exist"), { code: "P1003" }); } } });

    await expect(finance.ownershipMap({ req: new Request("http://test/api/expense/ownership-map"), params: {}, principal: principal(3, { isFinance: true }) }))
      .rejects.toMatchObject({ status: 503, message: "The catalog database does not exist; the infra operator checks its settings" });
  });
});

describeDb("GET account-mapping catalog", () => {
  it("answers 503 when the catalog database is unreachable, not empty lists", async () => {
    bindPorts({ catalog: { ...catalogResolving({}), listCategories: async () => { throw catalogDown(); } } });

    await expect(finance.mappingCatalog({ req: new Request("http://test/api/expense/account-mapping/catalog"), params: {}, principal: principal(3, { isFinance: true }) }))
      .rejects.toMatchObject({ status: 503, message: "Catalog categories are unavailable; try again" });
  });
});
