// Caller side of the X3 catalog crossing: every response is parsed against the shared shapes.
import { z } from "zod";
import { getExpenseRuntime } from "../runtime";
import type { CatalogCategory, CatalogSubcategory, ItemInfo, LookupEntry, LookupResult } from "../contract";
import {
  CatalogCategorySchema,
  CatalogSubcategorySchema,
  ItemInfoSchema,
  LookupResultArraySchema,
} from "./catalog-schemas";

export async function listCategories(): Promise<CatalogCategory[]> {
  return z.array(CatalogCategorySchema).parse(await getExpenseRuntime().catalog.listCategories());
}

export async function listSubcategories(): Promise<CatalogSubcategory[]> {
  return z.array(CatalogSubcategorySchema).parse(await getExpenseRuntime().catalog.listSubcategories());
}

export async function getItem(gtin13: string): Promise<ItemInfo | null> {
  return ItemInfoSchema.parse(await getExpenseRuntime().catalog.getItem(gtin13));
}

export async function lookupItems(retailer: string, lookups: LookupEntry[]): Promise<LookupResult[]> {
  return LookupResultArraySchema.parse(await getExpenseRuntime().catalog.lookupItems(retailer, lookups));
}
