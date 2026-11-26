import { beforeAll, beforeEach, expect, it } from "vitest";
import { describeDb, resetDb } from "../helpers/db";
import { initDb, prisma } from "../../db";
import { buildGtin13 } from "../../lib/gtin";
import { getActiveItem, getItem, getOrgProvisionalItem, searchItems, searchOrgProvisionalItems } from "../../services/readService";

beforeAll(async () => { await initDb(); });

const [DRILL, BITS, OLD_DRILL, HAMMER] = [1, 2, 3, 4].map((sequence) => buildGtin13("T", 1, sequence));

async function seedItems() {
  const category = await prisma.category.create({ data: { name: "Tools", letter: "T" } });
  const sub = await prisma.subcategory.create({ data: { name: "Power", number: 1, categoryId: category.id } });
  const item = (gtin13: string, sequence: number, name: string, archivedAt: Date | null = null) =>
    prisma.item.create({
      data: { gtin13, name, categoryId: category.id, subcategoryId: sub.id, sequence, usageBehavior: "Durable", archivedAt },
    });
  await item(DRILL, 1, "Cordless Drill");
  await item(BITS, 2, "Drill Bits");
  await item(OLD_DRILL, 3, "Old Drill", new Date());
  await item(HAMMER, 4, "Hammer");
}

describeDb("readService (X3/X10)", () => {
  beforeEach(async () => {
    await resetDb();
    await seedItems();
  });

  it("getItem includes the name beside the category ids", async () => {
    expect(await getItem(DRILL)).toMatchObject({ gtin13: DRILL, name: "Cordless Drill" });
    expect(await getItem("0000000000000")).toBeNull();
  });

  it("getActiveItem returns an approved item and null for an archived or unknown GTIN", async () => {
    expect(await getActiveItem(DRILL)).toEqual({ gtin13: DRILL, name: "Cordless Drill" });
    expect(await getActiveItem(OLD_DRILL)).toBeNull();
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
        { ...base, provisionalGtin13: "0200002700025", proposedName: "Shelf board", status: "approved", resultGtin13: DRILL },
        { ...base, provisionalGtin13: "0200002700032", proposedName: "Shelf rail", status: "mapped_to_existing", resultGtin13: BITS },
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
      { gtin13: DRILL, name: "Cordless Drill" },
      { gtin13: BITS, name: "Drill Bits" },
    ]);
    expect(await searchItems("000047")).toEqual([{ gtin13: HAMMER, name: "Hammer" }]);
  });

  it("searchItems matches an active reference's part number in any case, and not an archived one's", async () => {
    await prisma.itemReference.create({ data: { gtin13: HAMMER, partNumber: "HX-20N0001" } });
    await prisma.itemReference.create({ data: { gtin13: BITS, partNumber: "OLD-555", archivedAt: new Date() } });
    expect(await searchItems(" hx-20n ")).toEqual([{ gtin13: HAMMER, name: "Hammer" }]);
    expect(await searchItems("old-555")).toEqual([]);
  });

  it("searchItems matches the category and subcategory names in any case, like the item route", async () => {
    const active = [
      { gtin13: DRILL, name: "Cordless Drill" },
      { gtin13: BITS, name: "Drill Bits" },
      { gtin13: HAMMER, name: "Hammer" },
    ];
    expect(await searchItems("TOOLS")).toEqual(active);
    expect(await searchItems("owe")).toEqual(active);
  });

  it("a blank query matches nothing", async () => {
    expect(await searchItems("   ")).toEqual([]);
  });
});
