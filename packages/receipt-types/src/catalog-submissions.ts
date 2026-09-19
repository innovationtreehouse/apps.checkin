import { z } from "zod";

/**
 * S4 — workflow-mapping → global-catalog submission contract. The catalog
 * `/api/internal/*` routes parse inbound bodies against these schemas; the
 * workflow `catalog-client` parses its outbound bodies against the SAME schemas
 * before POSTing. Both ends import from here so a field rename cannot drift
 * undetected (previously the producer redeclared the shapes as inline types).
 */

export const catalogLookupEntrySchema = z.object({
  index: z.number().int(),
  partNumber: z.string().nullable().optional(),
  manufacturer: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
}).strict();

export const catalogItemsLookupSchema = z.object({
  retailer: z.string().min(1),
  lookups: z.array(catalogLookupEntrySchema),
}).strict();

export const catalogCheckReferencesSchema = z.object({
  retailer: z.string().optional(),
  partNumber: z.string().nullable().optional(),
  manufacturer: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
}).strict();

export const catalogItemReferenceProposalSchema = z.object({
  gtin13: z.string().min(1),
  localUserId: z.number().int(),
  partNumber: z.string().optional(),
  description: z.string().optional(),
  retailer: z.string().optional(),
  manufacturer: z.string().optional(),
  // Conversion factor = inventory units per receipt-line unit. Integer
  // system-wide (no fractional packs) so quantities never need rounding.
  conversionFactor: z.number().int().positive().optional(),
}).strict();

export const catalogProvisionalItemProposalSchema = z.object({
  provisionalGtin13: z.string().min(1),
  proposedName: z.string().min(1),
  proposedUsageBehavior: z.string().min(1),
  localUserId: z.number().int(),
  proposedCategoryId: z.number().int().optional(),
  proposedSubcategoryId: z.number().int().optional(),
  partNumber: z.string().optional(),
  manufacturer: z.string().optional(),
  retailer: z.string().optional(),
  // Human-entered at intake: the person holds the goods and knows how many
  // inventory units one receipt-line unit represents. Integer, positive.
  conversionFactor: z.number().int().positive().optional(),
}).strict();

export const catalogReferenceConflictSchema = z.object({
  itemReferenceId: z.number().int(),
  existingGtin13: z.string().min(1),
  proposedGtin13: z.string().min(1),
  receiptId: z.string().min(1),
  lineItemId: z.number().int(),
  manufacturer: z.string().optional(),
  retailer: z.string().optional(),
  partNumber: z.string().optional(),
  description: z.string().optional(),
}).strict();

export type CatalogItemsLookup = z.infer<typeof catalogItemsLookupSchema>;
export type CatalogCheckReferences = z.infer<typeof catalogCheckReferencesSchema>;
export type CatalogItemReferenceProposal = z.infer<typeof catalogItemReferenceProposalSchema>;
export type CatalogProvisionalItemProposal = z.infer<typeof catalogProvisionalItemProposalSchema>;
export type CatalogReferenceConflict = z.infer<typeof catalogReferenceConflictSchema>;
