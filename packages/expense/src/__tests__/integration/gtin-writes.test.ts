/** Part buckets and account rules take a checked GTIN-13 on new writes; rows already stored are left as they are. */
import { beforeEach, expect, it } from "vitest";
import { buildProvisionalGtin13 } from "@checkin/gtin";
import { describeDb } from "../helpers/db";
import { bindPorts, catalogResolving, principal, ORG } from "../helpers/seed";
import { db } from "../../db";
import { finance } from "../../routes";
import type { ExpenseRouteHandler } from "../../contract";

const CATALOG_GTIN = "4006381333931";
const PROVISIONAL = buildProvisionalGtin13(123);

function call(route: ExpenseRouteHandler, method: string, body: unknown, params: Record<string, string> = {}) {
  return route({ req: new Request("http://test/api/expense", { method, body: JSON.stringify(body) }), params, principal: principal(3, { isFinance: true }) });
}

const own = (gtin13: string) => call(finance.setOwnership, "PUT", { gtin13, ownerId: 100 });
const rule = (partNumber: string) => ({ category: "*", subcategory: "*", partNumber, isDelayed: null, isCapital: null, qbAccount: "5000" });

describeDb("GTIN writes", () => {
  beforeEach(() => bindPorts({ catalog: catalogResolving({ 1: CATALOG_GTIN }) }));

  it("maps a catalog part or one of the org's provisional parts to a bucket", async () => {
    await db.provisionalItemMap.create({ data: { orgId: ORG, provisionalGtin13: PROVISIONAL } });

    await own(CATALOG_GTIN);
    await own(PROVISIONAL);

    expect(await db.partOwnerMap.count({ where: { orgId: ORG } })).toBe(2);
  });

  it("refuses a wrong check digit, an unknown GTIN and a rejected provisional part", async () => {
    const rejected = buildProvisionalGtin13(124);
    await db.provisionalItemMap.create({ data: { orgId: ORG, provisionalGtin13: rejected, status: "rejected" } });

    for (const gtin13 of ["4006381333932", "0012345678905", rejected]) {
      await expect(own(gtin13)).rejects.toMatchObject({ status: 400 });
    }
    expect(await db.partOwnerMap.count()).toBe(0);
  });

  it("still moves a part already mapped to another bucket, whatever its GTIN", async () => {
    await db.partOwnerMap.create({ data: { orgId: ORG, gtin13: "0012345678905", ownerId: 101 } });

    await own("0012345678905");

    expect(await db.partOwnerMap.findFirst({ where: { orgId: ORG, gtin13: "0012345678905" } })).toMatchObject({ ownerId: 100 });
  });

  it("an account rule takes `*` or a checked GTIN-13 as its part", async () => {
    await call(finance.createAccountMapping, "POST", rule("*"));
    await call(finance.createAccountMapping, "POST", rule(CATALOG_GTIN));
    for (const bad of ["03B0042", "4006381333932", "ABC-123"]) {
      await expect(call(finance.createAccountMapping, "POST", rule(bad))).rejects.toMatchObject({ status: 400 });
    }
    expect(await db.accountMapping.count()).toBe(2);
  });

  it("an existing rule whose part never matches can still be edited without changing its part", async () => {
    const legacy = await db.accountMapping.create({ data: { orgId: ORG, ...rule("ABC-123") } });
    const id = String(legacy.id);

    await call(finance.updateAccountMapping, "PUT", { ...rule("ABC-123"), qbAccount: "6000" }, { id });
    await expect(call(finance.updateAccountMapping, "PUT", rule("XYZ-9"), { id })).rejects.toMatchObject({ status: 400 });

    expect(await db.accountMapping.findUniqueOrThrow({ where: { id: legacy.id } })).toMatchObject({ partNumber: "ABC-123", qbAccount: "6000" });
  });
});
