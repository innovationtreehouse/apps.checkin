import { beforeAll, beforeEach, expect, it } from "vitest";
import { describeDb, resetDb } from "../helpers/db";
import { initDb, prisma } from "../../db";
import { getActiveItem, getItem, getOrgProvisionalItem, searchItems, searchOrgProvisionalItems } from "../../services/readService";

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

  it("getOrgProvisionalItem returns this org's provisional part and null for another org's", async () => {
    const part = { provisionalGtin13: "0200002700001", proposedName: "Shelf bracket", proposedUsageBehavior: "Durable", localUserId: 1 };
    await prisma.provisionalItem.create({ data: { ...part, orgId: "org-a", status: "rejected" } });
    expect(await getOrgProvisionalItem("org-a", part.provisionalGtin13)).toEqual({ status: "rejected", proposedName: "Shelf bracket", resolvedToGtin13: null });
    expect(await getOrgProvisionalItem("org-b", part.provisionalGtin13)).toBeNull();
    expect(await getOrgProvisionalItem("org-a", "0200002700018")).toBeNull();
  });

  it("searchOrgProvisionalItems lists this org's pending and rejected parts by name (any case) or GTIN", async () => {
    const base = { proposedUsageBehavior: "Durable", localUserId: 1, orgId: "org-a" };
    await prisma.provisionalItem.createMany({
      data: [
        { ...base, provisionalGtin13: "0200002700001", proposedName: "Shelf bracket", status: "rejected" },
        { ...base, provisionalGtin13: "0200002700018", proposedName: "Shelf pin", status: "pending" },
        { ...base, provisionalGtin13: "0200002700025", proposedName: "Shelf board", status: "approved", resultGtin13: "0011111111116" },
        { ...base, provisionalGtin13: "0200002700032", proposedName: "Shelf rail", status: "mapped_to_existing", resultGtin13: "0022222222223" },
        { ...base, provisionalGtin13: "0200002700049", proposedName: "Shelf clip", status: "pending", orgId: "org-b" },
      ],
    });
    expect(await searchOrgProvisionalItems("org-a", "SHELF")).toEqual([
      { gtin13: "0200002700001", name: "Shelf bracket", status: "rejected" },
      { gtin13: "0200002700018", name: "Shelf pin", status: "pending" },
    ]);
    expect(await searchOrgProvisionalItems("org-a", "0200002700018")).toEqual([{ gtin13: "0200002700018", name: "Shelf pin", status: "pending" }]);
    expect(await searchOrgProvisionalItems("org-a", "P000000")).toEqual([{ gtin13: "0200002700001", name: "Shelf bracket", status: "rejected" }]);
    expect(await searchOrgProvisionalItems("org-a", " p000001 ")).toEqual([{ gtin13: "0200002700018", name: "Shelf pin", status: "pending" }]);
    expect(await searchOrgProvisionalItems("org-a", "P000002")).toEqual([]);
    expect(await searchOrgProvisionalItems("org-b", "0200002700018")).toEqual([]);
    expect(await searchOrgProvisionalItems("org-a", "  ")).toEqual([]);
  });

  it("searchOrgProvisionalItems returns at most 20 parts", async () => {
    await prisma.provisionalItem.createMany({
      data: Array.from({ length: 25 }, (_, i) => ({
        provisionalGtin13: `02000028${String(i).padStart(5, "0")}`,
        proposedName: `Hinge ${String(i).padStart(2, "0")}`,
        proposedUsageBehavior: "Durable",
        localUserId: 1,
        orgId: "org-a",
      })),
    });
    expect(await searchOrgProvisionalItems("org-a", "hinge")).toHaveLength(20);
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
