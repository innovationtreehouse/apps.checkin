/**
 * View models for the catalog UI (#1286 track 5).
 *
 * These mirror the JSON the /api/catalog/* routes actually return — Prisma model
 * bags stripped by checkin's handler(), NOT the source app's flattened shapes.
 * Concretely: list routes return a bare array of rows (no {items,total,page}
 * envelope — dropped in track 4), item rows carry nested `category`/`subcategory`
 * relations rather than flattened `category`/`categoryLetter` strings, and dates
 * arrive as ISO strings over the wire. Keep these in sync with the route
 * factories in ../routes/* and the includes in ../repositories/*.
 */

export const USAGE_BEHAVIORS = [
  "Single Use",
  "Short Life Consumable",
  "Long Life Consumable",
  "Durable",
] as const;
export type UsageBehavior = (typeof USAGE_BEHAVIORS)[number];

export interface CategoryRow {
  id: number;
  name: string;
  letter: string;
  archivedAt: string | null;
}

export interface SubcategoryRow {
  id: number;
  name: string;
  number: number;
  categoryId: number;
  archivedAt: string | null;
}

/** GET /api/catalog/items rows: Item scalars + the category/subcategory includes. */
export interface ItemRow {
  gtin13: string;
  name: string;
  categoryId: number;
  subcategoryId: number;
  sequence: number;
  usageBehavior: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  category: { name: string; letter: string };
  subcategory: { name: string; number: number };
}

/**
 * ItemReference rows. The paginated list includes `item: { name }`; the
 * by-gtin list (the references modal) returns bare rows, so `item` is optional.
 * `description` is stored normalized (`descriptionNormalized`) but writes accept
 * a plain `description` field.
 */
export interface ItemReferenceRow {
  id: number;
  gtin13: string;
  partNumber: string | null;
  descriptionNormalized: string | null;
  manufacturer: string | null;
  retailer: string | null;
  url: string | null;
  conversionFactor: number;
  conversionVersion: number;
  archivedAt: string | null;
  item?: { name: string };
}

export interface ItemReferenceProposalRow {
  id: number;
  partNumber: string | null;
  description: string | null;
  retailer: string | null;
  manufacturer: string | null;
  gtin13: string;
  orgId: string;
  orgName: string;
  proposedAt: string;
  status: string;
  conversionFactor: number;
  item: { name: string };
}

export interface ProvisionalItemRow {
  id: number;
  provisionalGtin13: string;
  orgId: string;
  orgName: string;
  proposedName: string;
  proposedCategoryId: number | null;
  proposedSubcategoryId: number | null;
  proposedUsageBehavior: string;
  partNumber: string | null;
  manufacturer: string | null;
  retailer: string | null;
  proposedAt: string;
  status: string;
  resultGtin13: string | null;
  conversionFactor: number;
}

export interface ConversionChallengeRow {
  id: number;
  itemReferenceId: number;
  orgId: string;
  orgName: string;
  currentFactor: number;
  proposedFactor: number;
  reason: string;
  status: string;
  createdAt: string;
  /** internal tier — present only in the manager view. */
  localUserId?: number;
  itemReference: {
    partNumber: string | null;
    descriptionNormalized: string | null;
    manufacturer: string | null;
    retailer: string | null;
    gtin13: string;
    item: { name: string };
  };
}

export interface ReferenceConflictRow {
  id: number;
  itemReferenceId: number;
  existingGtin13: string;
  proposedGtin13: string;
  manufacturer: string | null;
  retailer: string | null;
  partNumber: string | null;
  description: string | null;
  createdAt: string;
  resolvedAt: string | null;
  resolution: string | null;
}
