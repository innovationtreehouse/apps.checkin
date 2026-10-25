/** The part-bucket map names each mapped part from the catalog. */
import { expect, it, vi } from "vitest";
import { describeDb } from "../helpers/db";
import { bindPorts, catalogResolving, principal, ORG } from "../helpers/seed";
import { db } from "../../db";
import { finance } from "../../routes";

const NAMED = "0012345678905";
const UNNAMED = "0098765432109";

describeDb("GET ownership-map", () => {
  it("returns the catalog name of each mapped part on the page, and nothing for an unknown GTIN", async () => {
    const getItemNames = vi.fn(async (gtins: string[]) => [{ gtin13: NAMED, name: "Hex bolt M6" }].filter((i) => gtins.includes(i.gtin13)));
    bindPorts({ auth: { getPrincipal: async () => principal(3, { isFinance: true }) }, catalog: { ...catalogResolving({}), getItemNames } });
    await db.partOwnerMap.createMany({ data: [{ orgId: ORG, gtin13: NAMED, ownerId: 100 }, { orgId: ORG, gtin13: UNNAMED, ownerId: 100 }] });

    const res = await finance.ownershipMap({ req: new Request("http://test/api/expense/ownership-map"), params: {} });

    expect(getItemNames).toHaveBeenCalledWith([NAMED, UNNAMED]);
    expect(res).toMatchObject({
      PartOwnerMap: [{ gtin13: NAMED }, { gtin13: UNNAMED }],
      Item: [{ gtin13: NAMED, name: "Hex bolt M6" }],
    });
  });

  it("asks the catalog nothing when no part is mapped", async () => {
    const getItemNames = vi.fn(async () => []);
    bindPorts({ auth: { getPrincipal: async () => principal(3, { isFinance: true }) }, catalog: { ...catalogResolving({}), getItemNames } });

    expect(await finance.ownershipMap({ req: new Request("http://test/api/expense/ownership-map"), params: {} })).toMatchObject({ PartOwnerMap: [], Item: [] });
    expect(getItemNames).not.toHaveBeenCalled();
  });
});
