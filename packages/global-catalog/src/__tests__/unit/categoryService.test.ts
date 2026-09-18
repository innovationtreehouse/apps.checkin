import { beforeAll, expect, it } from "vitest";
import { describeDb } from "@/__tests__/helpers/db";
import { initDb, prisma } from "@/db";
import { resetDb } from "@/__tests__/helpers/db";
import { resolveOrCreateCategory, resolveOrCreateSubcategory } from "@/services/categoryService";

beforeAll(async () => {
  await initDb();
});

async function seedCategory(name = "Existing Cat", letter = "E") {
  return prisma.category.create({ data: { name, letter } });
}

async function seedSubcategory(categoryId: number, name = "Existing Sub", number = 1) {
  return prisma.subcategory.create({ data: { name, number, categoryId } });
}

describeDb("resolveOrCreateCategory", () => {
  it("returns_existing_category_by_id", async () => {
    await resetDb();
    const cat = await seedCategory();
    const result = await resolveOrCreateCategory({ categoryId: cat.id });
    expect(result).toEqual({ id: cat.id, letter: cat.letter });
  });

  it("throws_404_when_categoryId_does_not_exist", async () => {
    await resetDb();
    await expect(resolveOrCreateCategory({ categoryId: 999999 })).rejects.toMatchObject({ status: 404 });
  });

  it("creates_new_category_with_uppercased_letter_when_name_and_letter_given", async () => {
    await resetDb();
    const result = await resolveOrCreateCategory({ categoryName: "Brand New Cat", categoryLetter: "z" });
    expect(result.letter).toBe("Z");
    const created = await prisma.category.findFirst({ where: { id: result.id } });
    expect(created?.name).toBe("Brand New Cat");
    expect(created?.letter).toBe("Z");
  });

  it("throws_409_when_category_name_already_exists", async () => {
    await resetDb();
    const cat = await seedCategory("Dup Name Cat", "D");
    await expect(
      resolveOrCreateCategory({ categoryName: cat.name, categoryLetter: "Q" })
    ).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/already exists/i) });
  });

  it("throws_409_when_category_letter_already_in_use", async () => {
    await resetDb();
    await seedCategory("Letter Holder", "L");
    await expect(
      resolveOrCreateCategory({ categoryName: "Different Name", categoryLetter: "l" })
    ).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/already in use/i) });
  });

  it("resolves_proposedCategoryId_when_it_exists", async () => {
    await resetDb();
    const cat = await seedCategory();
    const result = await resolveOrCreateCategory({ proposedCategoryId: cat.id });
    expect(result).toEqual({ id: cat.id, letter: cat.letter });
  });

  it("throws_400_when_proposedCategoryId_no_longer_exists", async () => {
    await resetDb();
    await expect(
      resolveOrCreateCategory({ proposedCategoryId: 999999 })
    ).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/no longer exists/i) });
  });

  it("ignores_proposedCategoryId_when_explicitly_null", async () => {
    await resetDb();
    await expect(resolveOrCreateCategory({ proposedCategoryId: null })).rejects.toMatchObject({ status: 400 });
  });

  it("throws_400_when_nothing_specified", async () => {
    await resetDb();
    await expect(resolveOrCreateCategory({})).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/a category must be specified/i),
    });
  });
});

describeDb("resolveOrCreateSubcategory", () => {
  it("returns_existing_subcategory_by_id_when_it_belongs_to_category", async () => {
    await resetDb();
    const cat = await seedCategory();
    const sub = await seedSubcategory(cat.id);
    const result = await resolveOrCreateSubcategory({ subcategoryId: sub.id, categoryId: cat.id });
    expect(result).toEqual({ id: sub.id, number: sub.number });
  });

  it("throws_404_when_subcategoryId_does_not_exist", async () => {
    await resetDb();
    const cat = await seedCategory();
    await expect(
      resolveOrCreateSubcategory({ subcategoryId: 999999, categoryId: cat.id })
    ).rejects.toMatchObject({ status: 404 });
  });

  it("throws_400_when_subcategory_belongs_to_a_different_category", async () => {
    await resetDb();
    const cat = await seedCategory("Cat A", "A");
    const otherCat = await seedCategory("Cat B", "B");
    const sub = await seedSubcategory(otherCat.id);
    await expect(
      resolveOrCreateSubcategory({ subcategoryId: sub.id, categoryId: cat.id })
    ).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/does not belong/i) });
  });

  it("creates_new_subcategory_when_name_and_number_given", async () => {
    await resetDb();
    const cat = await seedCategory();
    const result = await resolveOrCreateSubcategory({ subcategoryName: "New Sub", subcategoryNumber: 5, categoryId: cat.id });
    const created = await prisma.subcategory.findFirst({ where: { id: result.id } });
    expect(created?.name).toBe("New Sub");
    expect(created?.number).toBe(5);
    expect(created?.categoryId).toBe(cat.id);
  });

  it("throws_409_when_subcategory_name_conflicts_within_same_category", async () => {
    await resetDb();
    const cat = await seedCategory();
    const sub = await seedSubcategory(cat.id, "Taken Name", 1);
    await expect(
      resolveOrCreateSubcategory({ subcategoryName: sub.name, subcategoryNumber: 2, categoryId: cat.id })
    ).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/already exists in this category/i) });
  });

  it("throws_409_when_subcategory_number_conflicts_within_same_category", async () => {
    await resetDb();
    const cat = await seedCategory();
    const sub = await seedSubcategory(cat.id, "First Sub", 7);
    await expect(
      resolveOrCreateSubcategory({ subcategoryName: "Second Sub", subcategoryNumber: sub.number, categoryId: cat.id })
    ).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/already in use in this category/i) });
  });

  it("allows_same_name_and_number_in_different_categories", async () => {
    await resetDb();
    const catA = await seedCategory("Cat A", "A");
    const catB = await seedCategory("Cat B", "B");
    await seedSubcategory(catA.id, "Shared Name", 1);
    const result = await resolveOrCreateSubcategory({ subcategoryName: "Shared Name", subcategoryNumber: 1, categoryId: catB.id });
    expect(result.number).toBe(1);
  });

  it("resolves_proposedSubcategoryId_when_it_exists", async () => {
    await resetDb();
    const cat = await seedCategory();
    const sub = await seedSubcategory(cat.id);
    const result = await resolveOrCreateSubcategory({ proposedSubcategoryId: sub.id, categoryId: cat.id });
    expect(result).toEqual({ id: sub.id, number: sub.number });
  });

  it("throws_400_when_proposedSubcategoryId_no_longer_exists", async () => {
    await resetDb();
    const cat = await seedCategory();
    await expect(
      resolveOrCreateSubcategory({ proposedSubcategoryId: 999999, categoryId: cat.id })
    ).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/no longer exists/i) });
  });

  it("ignores_proposedSubcategoryId_when_explicitly_null", async () => {
    await resetDb();
    const cat = await seedCategory();
    await expect(resolveOrCreateSubcategory({ proposedSubcategoryId: null, categoryId: cat.id })).rejects.toMatchObject({ status: 400 });
  });

  it("throws_400_when_nothing_specified", async () => {
    await resetDb();
    const cat = await seedCategory();
    await expect(resolveOrCreateSubcategory({ categoryId: cat.id })).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/a subcategory must be specified/i),
    });
  });
});
