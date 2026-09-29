import { beforeAll, expect, it } from "vitest";
import { describeDb } from "../helpers/db";
import { initDb, prisma } from "../../db";
import { resetDb } from "../helpers/db";
import { resolveItemContext, createItem, allocateAndInsertItem } from "../../services/itemService";

beforeAll(async () => { await initDb(); });

async function seedCategory(name = "Test Cat", letter = "T") {
  return prisma.category.create({ data: { name, letter } });
}

async function seedSubcategory(categoryId: number, name = "Test Sub", number = 1) {
  return prisma.subcategory.create({ data: { name, number, categoryId } });
}

// ── resolveItemContext ────────────────────────────────────────────────────────

describeDb("resolveItemContext", () => {
  it("throws 404 when category not found", async () => {
    await resetDb();
    await expect(
      resolveItemContext({ name: "Widget", categoryId: 9999, subcategoryId: 1, usageBehavior: "Durable" })
    ).rejects.toMatchObject({ status: 404, message: expect.stringMatching(/category not found/i) });
  });

  it("throws 404 when subcategory not found", async () => {
    await resetDb();
    const cat = await seedCategory();
    await expect(
      resolveItemContext({ name: "Widget", categoryId: cat.id, subcategoryId: 9999, usageBehavior: "Durable" })
    ).rejects.toMatchObject({ status: 404, message: expect.stringMatching(/subcategory not found/i) });
  });

  it("throws 400 when subcategory does not belong to the given category", async () => {
    await resetDb();
    const catA = await seedCategory("Cat A", "A");
    const catB = await seedCategory("Cat B", "B");
    const subB = await seedSubcategory(catB.id, "Sub of B", 1);
    await expect(
      resolveItemContext({ name: "Widget", categoryId: catA.id, subcategoryId: subB.id, usageBehavior: "Durable" })
    ).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/does not belong/i) });
  });

  it("throws 409 when active item with same name already exists", async () => {
    await resetDb();
    const cat = await seedCategory();
    const sub = await seedSubcategory(cat.id);
    await prisma.item.create({ data: {
      gtin13: "T0100000001", name: "Duplicate Widget", categoryId: cat.id,
      subcategoryId: sub.id, sequence: 1, usageBehavior: "Durable", createdAt: new Date(), updatedAt: new Date(),
    } });
    await expect(
      resolveItemContext({ name: "Duplicate Widget", categoryId: cat.id, subcategoryId: sub.id, usageBehavior: "Durable" })
    ).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/already exists/i) });
  });

  it("ignores archived items when checking for name duplicates", async () => {
    await resetDb();
    const cat = await seedCategory();
    const sub = await seedSubcategory(cat.id);
    await prisma.item.create({ data: {
      gtin13: "T0100000001", name: "Archived Widget", categoryId: cat.id,
      subcategoryId: sub.id, sequence: 1, usageBehavior: "Durable",
      createdAt: new Date(), updatedAt: new Date(), archivedAt: new Date(),
    } });
    const ctx = await resolveItemContext({ name: "Archived Widget", categoryId: cat.id, subcategoryId: sub.id, usageBehavior: "Durable" });
    expect(ctx.name).toBe("Archived Widget");
  });

  it("trims whitespace from name and returns resolved context", async () => {
    await resetDb();
    const cat = await seedCategory("Tools", "T");
    const sub = await seedSubcategory(cat.id, "Hand Tools", 3);
    const ctx = await resolveItemContext({ name: "  Hammer  ", categoryId: cat.id, subcategoryId: sub.id, usageBehavior: "Durable" });
    expect(ctx.name).toBe("Hammer");
    expect(ctx.categoryLetter).toBe("T");
    expect(ctx.subcategoryNumber).toBe(3);
  });
});

// ── createItem ────────────────────────────────────────────────────────────────

describeDb("createItem", () => {
  it("creates item, assigns a GTIN13, and increments sequence within category/subcategory", async () => {
    await resetDb();
    const cat = await seedCategory("Hardware", "H");
    const sub = await seedSubcategory(cat.id, "Fasteners", 2);

    const first = await createItem({ name: "Bolt M6", categoryId: cat.id, subcategoryId: sub.id, usageBehavior: "Durable" });
    const second = await createItem({ name: "Nut M6", categoryId: cat.id, subcategoryId: sub.id, usageBehavior: "Durable" });

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(first.gtin13).toMatch(/^[0-9]{13}$/);
    expect(second.gtin13).not.toBe(first.gtin13);
  });

  it("sequences are independent per subcategory", async () => {
    await resetDb();
    const cat = await seedCategory("Hardware", "H");
    const subA = await seedSubcategory(cat.id, "Fasteners", 1);
    const subB = await seedSubcategory(cat.id, "Adhesives", 2);

    const itemA = await createItem({ name: "Bolt A", categoryId: cat.id, subcategoryId: subA.id, usageBehavior: "Durable" });
    const itemB = await createItem({ name: "Bolt B", categoryId: cat.id, subcategoryId: subB.id, usageBehavior: "Durable" });

    expect(itemA.sequence).toBe(1);
    expect(itemB.sequence).toBe(1);
    expect(itemA.gtin13).not.toBe(itemB.gtin13);
  });

  it("propagates ServiceError from resolveItemContext (category not found)", async () => {
    await resetDb();
    await expect(
      createItem({ name: "Widget", categoryId: 9999, subcategoryId: 1, usageBehavior: "Durable" })
    ).rejects.toMatchObject({ status: 404 });
  });

  it("propagates ServiceError from resolveItemContext (duplicate name)", async () => {
    await resetDb();
    const cat = await seedCategory();
    const sub = await seedSubcategory(cat.id);
    await createItem({ name: "Unique Widget", categoryId: cat.id, subcategoryId: sub.id, usageBehavior: "Durable" });
    await expect(
      createItem({ name: "Unique Widget", categoryId: cat.id, subcategoryId: sub.id, usageBehavior: "Durable" })
    ).rejects.toMatchObject({ status: 409 });
  });
});

// ── allocateAndInsertItem: sequence limit ─────────────────────────────────────

describeDb("allocateAndInsertItem: sequence limit guard", () => {
  it("throws 400 when next sequence would reach 9999", async () => {
    await resetDb();
    const cat = await seedCategory("Limit Cat", "L");
    const sub = await seedSubcategory(cat.id, "Limit Sub", 9);

    // Seed one item with sequence = 9998 to force nextSeq = 9999 on the next call
    await prisma.item.create({ data: {
      gtin13: "L0900009998", name: "Near Limit Item", categoryId: cat.id,
      subcategoryId: sub.id, sequence: 9998, usageBehavior: "Durable",
      createdAt: new Date(), updatedAt: new Date(),
    } });

    await expect(
      createItem({ name: "Over Limit", categoryId: cat.id, subcategoryId: sub.id, usageBehavior: "Durable" })
    ).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/sequence number limit/i) });
  });
});
