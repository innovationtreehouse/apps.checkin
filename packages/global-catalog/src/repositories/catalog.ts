import type { PrismaClient, Prisma } from "@/generated/prisma/client";

const ITEM_INCLUDE = {
  category: { select: { name: true, letter: true } },
  subcategory: { select: { name: true, number: true } },
} as const;

export function createCatalogRepository(db: PrismaClient) {
  return {
    // ── Categories ────────────────────────────────────────────────────────────

    findCategoryById: (id: number) =>
      db.category.findFirst({ where: { id } }),

    findCategoryByName: (name: string) =>
      db.category.findFirst({ where: { name } }),

    findCategoryByLetter: (letter: string) =>
      db.category.findFirst({ where: { letter } }),

    findActiveCategoryByLetter: (letter: string) =>
      db.category.findFirst({ where: { letter, archivedAt: null } }),

    findActiveCategoryByName: (name: string) =>
      db.category.findFirst({ where: { name, archivedAt: null } }),

    findActiveCategoryByLetterExcluding: (letter: string, excludeId: number) =>
      db.category.findFirst({ where: { letter, archivedAt: null, id: { not: excludeId } } }),

    findActiveCategoryByNameExcluding: (name: string, excludeId: number) =>
      db.category.findFirst({ where: { name, archivedAt: null, id: { not: excludeId } } }),

    listCategories: (includeArchived: boolean) =>
      includeArchived
        ? db.category.findMany({ orderBy: { name: "asc" } })
        : db.category.findMany({ where: { archivedAt: null }, orderBy: { name: "asc" } }),

    listCategoriesActive: () =>
      db.category.findMany({
        where: { archivedAt: null },
        orderBy: { name: "asc" },
        select: { id: true, name: true, letter: true },
      }),

    createCategory: (data: { name: string; letter: string }) =>
      db.category.create({ data }),

    updateCategory: (id: number, data: Prisma.CategoryUpdateInput) =>
      db.category.update({ where: { id }, data }),

    // ── Subcategories ─────────────────────────────────────────────────────────

    findSubcategoryById: (id: number) =>
      db.subcategory.findFirst({ where: { id } }),

    findActiveSubcategoryByNumber: (number: number, categoryId: number) =>
      db.subcategory.findFirst({ where: { number, categoryId, archivedAt: null } }),

    findActiveSubcategoryByName: (name: string, categoryId: number) =>
      db.subcategory.findFirst({ where: { name, categoryId, archivedAt: null } }),

    findActiveSubcategoryByNumberExcluding: (number: number, categoryId: number, excludeId: number) =>
      db.subcategory.findFirst({ where: { number, categoryId, archivedAt: null, id: { not: excludeId } } }),

    findActiveSubcategoryByNameExcluding: (name: string, categoryId: number, excludeId: number) =>
      db.subcategory.findFirst({ where: { name, categoryId, archivedAt: null, id: { not: excludeId } } }),

    listSubcategories: (where: Prisma.SubcategoryWhereInput) =>
      db.subcategory.findMany({ where, orderBy: { number: "asc" } }),

    listSubcategoriesActive: (categoryId?: number) => {
      const where = categoryId !== undefined
        ? { archivedAt: null as null, categoryId }
        : { archivedAt: null as null };
      return db.subcategory.findMany({
        where,
        orderBy: [{ categoryId: "asc" }, { number: "asc" }],
        select: { id: true, name: true, number: true, categoryId: true },
      });
    },

    createSubcategory: (data: { name: string; number: number; categoryId: number }) =>
      db.subcategory.create({ data }),

    updateSubcategory: (id: number, data: Prisma.SubcategoryUpdateInput) =>
      db.subcategory.update({ where: { id }, data }),

    // ── Items ─────────────────────────────────────────────────────────────────

    findItemByGtin13: (gtin13: string) =>
      db.item.findFirst({ where: { gtin13 } }),

    findItemByGtin13WithIncludes: (gtin13: string) =>
      db.item.findFirst({ where: { gtin13 }, include: ITEM_INCLUDE }),

    findItemByName: (name: string) =>
      db.item.findFirst({ where: { name, archivedAt: null } }),

    findItemByNameExcluding: (name: string, excludeGtin13: string) =>
      db.item.findFirst({ where: { name, archivedAt: null, gtin13: { not: excludeGtin13 } } }),

    findItemInCategory: (categoryId: number) =>
      db.item.findFirst({ where: { categoryId } }),

    findItemInSubcategory: (subcategoryId: number) =>
      db.item.findFirst({ where: { subcategoryId } }),

    findItemsByGtins: (gtins: string[]) =>
      db.item.findMany({ where: { gtin13: { in: gtins } }, select: { gtin13: true } }),

    findItemsWithNamesByGtins: (gtins: string[]) =>
      db.item.findMany({ where: { gtin13: { in: gtins } }, select: { gtin13: true, name: true } }),

    findItemByGtinForConflict: (gtin13: string) =>
      db.item.findFirst({ where: { gtin13 }, select: { name: true } }),

    listAllItemsFlat: () =>
      db.item.findMany({ where: { archivedAt: null }, include: ITEM_INCLUDE, orderBy: { name: "asc" } }),

    async listItemsPaginated(params: {
      where: Prisma.ItemWhereInput;
      orderBy: Prisma.ItemOrderByWithRelationInput[];
      page: number;
      limit: number;
    }) {
      const { where, orderBy, page, limit } = params;
      const [total, rows] = await Promise.all([
        db.item.count({ where }),
        db.item.findMany({
          where,
          include: ITEM_INCLUDE,
          orderBy,
          take: limit,
          skip: (page - 1) * limit,
        }),
      ]);
      return { total, rows };
    },

    aggregateItemMaxSequence: (categoryId: number, subcategoryId: number) =>
      db.item.aggregate({
        _max: { sequence: true },
        where: { categoryId, subcategoryId },
      }),

    createItem: (data: Prisma.ItemUncheckedCreateInput) =>
      db.item.create({ data }),

    updateItem: (gtin13: string, data: Prisma.ItemUncheckedUpdateInput) =>
      db.item.update({ where: { gtin13 }, data }),

    listItemsForAudit: () =>
      db.item.findMany({
        select: {
          gtin13: true, name: true,
          category: { select: { name: true } },
          subcategory: { select: { name: true } },
          createdAt: true, createdByUserId: true, createdByUsername: true,
          updatedAt: true, updatedByUserId: true, updatedByUsername: true, archivedAt: true,
        },
        orderBy: { updatedAt: "asc" },
      }),
  };
}

export type CatalogRepository = ReturnType<typeof createCatalogRepository>;
