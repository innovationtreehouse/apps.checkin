// Read-only catalog reference data for the host's CatalogReader adapter (X3).
import { db } from "../db";
import { createCatalogRepository } from "../repositories/catalog";

const catalogRepo = createCatalogRepository(db);

export function listCategories() {
  return catalogRepo.listCategoriesActive();
}

export function listSubcategories() {
  return catalogRepo.listSubcategoriesActive();
}

export async function getItem(gtin13: string) {
  const item = await catalogRepo.findItemByGtin13(gtin13);
  return item ? { gtin13: item.gtin13, categoryId: item.categoryId, subcategoryId: item.subcategoryId } : null;
}
