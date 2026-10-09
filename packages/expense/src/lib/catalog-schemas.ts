// Catalog reference-data shapes the X3 crossing parses (lib/catalog.ts).

import { z } from "zod";

export const CatalogCategorySchema = z.object({
  id: z.number(),
  name: z.string(),
  letter: z.string(),
});

export const CatalogSubcategorySchema = z.object({
  id: z.number(),
  name: z.string(),
  number: z.number(),
  categoryId: z.number(),
});

export const ItemInfoSchema = z.object({
  gtin13: z.string(),
  categoryId: z.number(),
  subcategoryId: z.number(),
}).nullable();

export const LookupResultSchema = z.object({
  index: z.number(),
  gtin13: z.string().nullable(),
  conversionVersion: z.number(),
});

export const LookupResultArraySchema = z.array(LookupResultSchema);

