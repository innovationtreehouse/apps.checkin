export type GlobalRole = "admin" | "global_manager";

export const USAGE_BEHAVIORS = [
  "Single Use",
  "Short Life Consumable",
  "Long Life Consumable",
  "Durable",
] as const;
export type UsageBehavior = (typeof USAGE_BEHAVIORS)[number];

export interface Category {
  id: number;
  name: string;
  letter: string;
  archivedAt: Date | null;
}

export interface Subcategory {
  id: number;
  name: string;
  number: number;
  categoryId: number;
  archivedAt: Date | null;
}

export interface Item {
  gtin13: string;
  name: string;
  categoryId: number;
  category: string;
  categoryLetter: string;
  subcategoryId: number;
  subcategory: string;
  subcategoryNumber: number;
  sequence: number;
  usageBehavior: UsageBehavior;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

export interface ItemReference {
  id: number;
  gtin13: string;
  partNumber: string | null;
  description: string | null;
  manufacturer: string | null;
  retailer: string | null;
  url: string | null;
  conversionFactor: number;
  conversionVersion: number;
  archivedAt: Date | null;
}

export interface ItemReferenceWithName extends ItemReference {
  itemName: string;
}

export interface ReferenceConflict {
  id: number;
  itemReferenceId: number;
  existingGtin13: string;
  existingItemName: string | null;
  proposedGtin13: string;
  proposedItemName: string | null;
  manufacturer: string | null;
  retailer: string | null;
  partNumber: string | null;
  description: string | null;
  receiptId: string;
  lineItemId: number;
  createdAt: Date;
  resolvedAt: Date | null;
  resolution: string | null;
  resolvedByUserId: number | null;
}

export type ItemReferenceProposalStatus = "pending" | "approved" | "rejected" | "superseded";
export type ProvisionalItemStatus = "pending" | "approved" | "rejected" | "mapped_to_existing";

export interface ItemReferenceProposal {
  id: number;
  partNumber: string | null;
  description: string | null;
  retailer: string | null;
  manufacturer: string | null;
  gtin13: string;
  orgId: string;
  orgName: string;
  localUserId: number;
  proposedAt: Date;
  status: ItemReferenceProposalStatus;
  reviewedByUserId: number | null;
  reviewedAt: Date | null;
  rejectionReason: string | null;
  conversionFactor: number;
  itemName: string;
}

export interface ProvisionalItem {
  id: number;
  provisionalGtin13: string;
  displayGtin: string;
  orgId: string;
  orgName: string;
  localUserId: number;
  proposedName: string;
  proposedCategoryId: number | null;
  proposedSubcategoryId: number | null;
  proposedUsageBehavior: UsageBehavior;
  proposedAt: Date;
  status: ProvisionalItemStatus;
  reviewedByUserId: number | null;
  reviewedAt: Date | null;
  rejectionReason: string | null;
  resultGtin13: string | null;
}

export type ConversionChallengeStatus = "pending" | "accepted" | "rejected";

export interface ConversionChallenge {
  id: number;
  itemReferenceId: number;
  localUserId: number;
  orgId: string;
  orgName: string;
  currentFactor: number;
  proposedFactor: number;
  reason: string;
  status: ConversionChallengeStatus;
  reviewedByUserId: number | null;
  reviewedAt: Date | null;
  createdAt: Date;
  itemReferencePartNumber: string | null;
  itemReferenceDescription: string | null;
  itemReferenceManufacturer: string | null;
  itemReferenceRetailer: string | null;
  gtin13: string;
  itemName: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}
