// Read-only catalog reference data for the host's CatalogReader adapters (X3, X10).
import { db } from "../db";
import { createCatalogRepository } from "../repositories/catalog";
import { createProposalRepository } from "../repositories/proposal";

const catalogRepo = createCatalogRepository(db);
const proposalRepo = createProposalRepository(db);

const SEARCH_LIMIT = 25;
const PROVISIONAL_SEARCH_LIMIT = 20;

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

/** This org's provisional part with this GTIN, with the real part it resolved to; null for another org's or an unknown GTIN. */
export async function getOrgProvisionalItem(orgId: string, gtin13: string) {
  const row = await proposalRepo.findOrgProvisionalItemByGtin13(orgId, gtin13);
  return row ? { status: row.status, proposedName: row.proposedName, resolvedToGtin13: row.resultGtin13 } : null;
}

/** Up to 20 of this org's pending or local-only (rejected) provisional parts named like the query in any case, or with that GTIN or short Part ID; a blank query matches nothing. */
export async function searchOrgProvisionalItems(orgId: string, query: string) {
  const q = query.trim();
  if (!q) return [];
  const rows = await proposalRepo.searchOrgOpenProvisionalItems(orgId, q, PROVISIONAL_SEARCH_LIMIT);
  return rows.map((r) => ({ gtin13: r.provisionalGtin13, name: r.proposedName, status: r.status }));
}

/** Up to `take` active items whose name, GTIN, active reference part number, category or subcategory name contains the query in any case; a blank query matches nothing. */
export async function searchItems(query: string, take = SEARCH_LIMIT) {
  const q = query.trim();
  return q ? catalogRepo.searchItemsActive(q, take) : [];
}
