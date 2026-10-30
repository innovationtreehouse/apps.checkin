import { beforeAll, beforeEach, expect, it } from "vitest";
import { describeDb, resetDb } from "../helpers/db";
import { initDb, prisma } from "../../db";
import { count, list } from "../../routes/items";

beforeAll(async () => { await initDb(); });

const search = (q: string) => ({ req: new Request(`http://test/api/catalog/items?q=${encodeURIComponent(q)}`), params: {} });
const names = async (q: string) => ((await list(search(q))).Item as { name: string }[]).map((i) => i.name);

describeDb("GET /api/catalog/items search", () => {
  beforeEach(async () => {
    await resetDb();
    const category = await prisma.category.create({ data: { name: "Electrical", letter: "E" } });
    const sub = await prisma.subcategory.create({ data: { name: "Distribution", number: 1, categoryId: category.id } });
    const item = (gtin13: string, name: string) =>
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

  it("counts the same rows the list returns", async () => {
    expect(await count(search("power"))).toEqual({ CatalogItemCount: { total: 1 } });
  });
});
