import { beforeAll, beforeEach, expect, it } from "vitest";
import { describeDb, resetDb } from "../helpers/db";
import { buildGtin13, buildProvisionalGtin13 } from "@checkin/gtin";
import { initDb, prisma } from "../../db";
import { createCatalogRepository } from "../../repositories/catalog";
import { count, list } from "../../routes/items";

beforeAll(async () => { await initDb(); });

const search = (q: string) => ({ req: new Request(`http://test/api/catalog/items?q=${encodeURIComponent(q)}`), params: {} });
const names = async (q: string) => ((await list(search(q))).Item as { name: string }[]).map((i) => i.name);

describeDb("GET /api/catalog/items search", () => {
  let item: (gtin13: string, name: string) => Promise<unknown>;

  beforeEach(async () => {
    await resetDb();
    const category = await prisma.category.create({ data: { name: "Electrical", letter: "E" } });
    const sub = await prisma.subcategory.create({ data: { name: "Distribution", number: 1, categoryId: category.id } });
    item = (gtin13, name) =>
      prisma.item.create({
        data: { gtin13, name, categoryId: category.id, subcategoryId: sub.id, sequence: 1, usageBehavior: "Durable" },
      });
    await item("0011111111116", "Power Distribution Hub");
    await item("0022222222223", "Hammer");
  });

  it("finds an item by a lowercase word from its name", async () => {
    expect(await names("power")).toEqual(["Power Distribution Hub"]);
  });

  it("matches a substring from the middle of the name in any case", async () => {
    expect(await names("TRIBUTION h")).toEqual(["Power Distribution Hub"]);
  });

  it("matches the category and subcategory names in any case", async () => {
    expect(await names("electrical")).toEqual(["Hammer", "Power Distribution Hub"]);
    expect(await names("distribution")).toEqual(["Hammer", "Power Distribution Hub"]);
  });

  it("finds a catalog or provisional item by its short ID in any case", async () => {
    await item(buildGtin13("E", 1, 7), "Breaker");
    await item(buildProvisionalGtin13(123), "Mystery part");
    expect(await names("01E0007")).toEqual(["Breaker"]);
    expect(await names("01e0007")).toEqual(["Breaker"]);
    expect(await names("P000123")).toEqual(["Mystery part"]);
    expect(await count(search("01E0007"))).toEqual({ CatalogItemCount: { total: 1 } });
  });

  it("finds an item by its short ID through the reader search", async () => {
    await item(buildGtin13("E", 1, 7), "Breaker");
    const found = await createCatalogRepository(prisma).searchItemsActive("01E0007", 20);
    expect(found.map((i) => i.name)).toEqual(["Breaker"]);
  });

  it("counts the same rows the list returns", async () => {
    expect(await count(search("power"))).toEqual({ CatalogItemCount: { total: 1 } });
  });
});
