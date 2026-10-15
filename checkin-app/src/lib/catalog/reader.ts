/**
 * X3/X10: the catalog's reads, bound in-process into each consumer's catalog port
 * (expense, workflow-mapping, bulk-donation). One object satisfies every port
 * structurally; each consumer parses the responses on its side.
 *
 * Display reads fall back to the consumer's inert result (empty / null) and log when
 * the catalog is unreachable. `checkReferences` gates a reference proposal, so it
 * fails closed: the error propagates and the line holds.
 */
import { readService, referenceMatchingService } from "@inventory/global-catalog";
import { catalogCheckReferencesSchema, catalogLookupEntrySchema } from "@inventory/receipt-types";
import type { CatalogItemsLookup, CatalogCheckReferences } from "@inventory/receipt-types";

async function orInert<T>(method: string, read: () => Promise<T>, inert: T): Promise<T> {
  try {
    return await read();
  } catch (err) {
    console.warn(`[catalog-reader] ${method} unavailable; returning the inert result`, err);
    return inert;
  }
}

export const catalogReader = {
  listCategories: () => orInert("listCategories", () => readService.listCategories(), []),

  listSubcategories: () => orInert("listSubcategories", () => readService.listSubcategories(), []),

  getItem: (gtin13: string) => orInert("getItem", () => readService.getItem(gtin13), null),

  searchItems: (query: string) => orInert("searchItems", () => readService.searchItems(query), []),

  async lookupItems(retailer: string, lookups: CatalogItemsLookup["lookups"]) {
    const entries = catalogLookupEntrySchema.array().parse(lookups);
    return orInert("lookupItems", () => referenceMatchingService.lookupMany(retailer, entries), []);
  },

  async checkReferences(fields: CatalogCheckReferences) {
    try {
      return await referenceMatchingService.checkReferences(catalogCheckReferencesSchema.parse(fields));
    } catch (err) {
      console.warn("[catalog-reader] checkReferences failed; the line holds", err);
      throw err;
    }
  },
};
