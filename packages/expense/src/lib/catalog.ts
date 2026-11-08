// Caller side of the X3 catalog crossing: every response is parsed against the shared shapes.
import { z } from "zod";
import { getExpenseRuntime } from "../runtime";
import type { CatalogCategory, CatalogSubcategory, ItemInfo, ItemName, LookupEntry, LookupResult } from "../contract";
import {
  ActiveItemSchema,
  CatalogCategorySchema,
  CatalogSubcategorySchema,
  ItemInfoSchema,
  ItemNameArraySchema,
  LookupResultArraySchema,
} from "./catalog-schemas";

/** The 503 a person reads when the catalog database is missing. */
export const CATALOG_DB_MISSING = "The catalog database does not exist; the infra operator checks its settings";

export async function listCategories(): Promise<CatalogCategory[]> {
  return z.array(CatalogCategorySchema).parse(await getExpenseRuntime().catalog.listCategories());
}

export async function listSubcategories(): Promise<CatalogSubcategory[]> {
  return z.array(CatalogSubcategorySchema).parse(await getExpenseRuntime().catalog.listSubcategories());
}

export async function getItem(gtin13: string): Promise<ItemInfo | null> {
  return ItemInfoSchema.parse(await getExpenseRuntime().catalog.getItem(gtin13));
}

/** The approved, non-archived item with this GTIN, or null. */
export async function getActiveItem(gtin13: string): Promise<{ gtin13: string; name: string } | null> {
  return ActiveItemSchema.parse(await getExpenseRuntime().catalog.getActiveItem(gtin13));
}

/** The catalog name of each listed GTIN the catalog knows. */
export async function getItemNames(gtin13s: string[]): Promise<ItemName[]> {
  if (gtin13s.length === 0) return [];
  return ItemNameArraySchema.parse(await getExpenseRuntime().catalog.getItemNames(gtin13s));
}

export async function lookupItems(retailer: string, lookups: LookupEntry[]): Promise<LookupResult[]> {
  return LookupResultArraySchema.parse(await getExpenseRuntime().catalog.lookupItems(retailer, lookups));
}
