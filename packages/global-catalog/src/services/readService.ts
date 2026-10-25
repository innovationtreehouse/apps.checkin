// Read-only catalog reference data for the host's CatalogReader adapters (X3, X10).
import { db } from "../db";
import { createCatalogRepository } from "../repositories/catalog";

const catalogRepo = createCatalogRepository(db);

const SEARCH_LIMIT = 25;

export function listCategories() {
  return catalogRepo.listCategoriesActive();
}

export function listSubcategories() {
  return catalogRepo.listSubcategoriesActive();
}

export async function getItem(gtin13: string) {
  const item = await catalogRepo.findItemByGtin13(gtin13);
  return item ? { gtin13: item.gtin13, name: item.name, categoryId: item.categoryId, subcategoryId: item.subcategoryId } : null;
}

/** The GTIN and name of each listed item; unknown GTINs are absent. */
export function getItemNames(gtin13s: string[]) {
  return gtin13s.length ? catalogRepo.findItemsWithNamesByGtins(gtin13s) : Promise.resolve([]);
}

/** The approved, non-archived item with this GTIN, or null. */
export function getActiveItem(gtin13: string) {
  return catalogRepo.findActiveItemByGtin13(gtin13);
}

/** Active items whose name or GTIN contains the query; a blank query matches nothing. */
export async function searchItems(query: string) {
  const q = query.trim();
  return q ? catalogRepo.searchItemsActive(q, SEARCH_LIMIT) : [];
}
