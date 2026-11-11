/**
 * X3/X10: the catalog's reads, bound in-process into each consumer's catalog port
 * (expense, workflow-mapping, bulk-donation). One object satisfies every port
 * structurally; each consumer parses the responses on its side.
 *
 * Every read passes its failure up; an unreachable catalog database reads as a system
 * failure (`kindOf`), and the caller decides whether to hold, degrade or refuse.
 */
import { readService, referenceMatchingService } from "@checkin/global-catalog";
import { catalogCheckReferencesSchema, catalogLookupEntrySchema } from "@checkin/receipt-types";
import type { CatalogItemsLookup, CatalogCheckReferences } from "@checkin/receipt-types";

export const catalogReader = {
  listCategories: () => readService.listCategories(),

  listSubcategories: () => readService.listSubcategories(),

  getItem: (gtin13: string) => readService.getItem(gtin13),

  getItemNames: (gtin13s: string[]) => readService.getItemNames(gtin13s),

  searchItems: (query: string, take?: number) => readService.searchItems(query, take),

  async lookupItems(retailer: string, lookups: CatalogItemsLookup["lookups"]) {
    return referenceMatchingService.lookupMany(retailer, catalogLookupEntrySchema.array().parse(lookups));
  },

  async checkReferences(fields: CatalogCheckReferences) {
    return referenceMatchingService.checkReferences(catalogCheckReferencesSchema.parse(fields));
  },

  getActiveItem: (gtin13: string) => readService.getActiveItem(gtin13),
};
