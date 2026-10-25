import { beforeAll, beforeEach, expect, it } from "vitest";
import { describeDb, resetDb } from "../helpers/db";
import { initDb, prisma } from "../../db";
import { getActiveItem, getItem, searchItems } from "../../services/readService";

beforeAll(async () => { await initDb(); });

async function seedItems() {
  const category = await prisma.category.create({ data: { name: "Tools", letter: "T" } });
  const sub = await prisma.subcategory.create({ data: { name: "Power", number: 1, categoryId: category.id } });
  const item = (gtin13: string, name: string, archivedAt: Date | null = null) =>
    prisma.item.create({
      data: { gtin13, name, categoryId: category.id, subcategoryId: sub.id, sequence: 1, usageBehavior: "Durable", archivedAt },
    });
  await item("0011111111116", "Cordless Drill");
  await item("0022222222223", "Drill Bits");
  await item("0033333333330", "Old Drill", new Date());
  await item("0044444444447", "Hammer");
}

describeDb("readService (X3/X10)", () => {
  beforeEach(async () => {
    await resetDb();
    await seedItems();
  });

  it("getItem includes the name beside the category ids", async () => {
    expect(await getItem("0011111111116")).toMatchObject({ gtin13: "0011111111116", name: "Cordless Drill" });
    expect(await getItem("0000000000000")).toBeNull();
  });

  it("getActiveItem returns an approved item and null for an archived or unknown GTIN", async () => {
    expect(await getActiveItem("0011111111116")).toEqual({ gtin13: "0011111111116", name: "Cordless Drill" });
    expect(await getActiveItem("0033333333330")).toBeNull();
    expect(await getActiveItem("0000000000000")).toBeNull();
  });

  it("searchItems matches active items by name (any case) or GTIN, returning gtin13 and name", async () => {
    expect(await searchItems("drill")).toEqual([
      { gtin13: "0011111111116", name: "Cordless Drill" },
      { gtin13: "0022222222223", name: "Drill Bits" },
    ]);
    expect(await searchItems("004444")).toEqual([{ gtin13: "0044444444447", name: "Hammer" }]);
  });

  it("searchItems matches the category and subcategory names in any case, like the item route", async () => {
    const active = [
      { gtin13: "0011111111116", name: "Cordless Drill" },
      { gtin13: "0022222222223", name: "Drill Bits" },
      { gtin13: "0044444444447", name: "Hammer" },
    ];
    expect(await searchItems("TOOLS")).toEqual(active);
    expect(await searchItems("owe")).toEqual(active);
  });

  it("a blank query matches nothing", async () => {
    expect(await searchItems("   ")).toEqual([]);
  });
});
