// Enum arrays for runtime validation (values must match DB strings exactly)
export const usageBehaviorEnum = [
  "Single Use",
  "Short Life Consumable",
  "Long Life Consumable",
  "Durable",
] as const;
export type UsageBehavior = (typeof usageBehaviorEnum)[number];

export const conflictResolutionEnum = ["keep_existing", "use_proposed"] as const;
export type ConflictResolution = (typeof conflictResolutionEnum)[number];

export const itemReferenceProposalStatusEnum = ["pending", "approved", "rejected", "superseded"] as const;
export type ItemReferenceProposalStatus = (typeof itemReferenceProposalStatusEnum)[number];

export const conversionChallengeStatusEnum = ["pending", "accepted", "rejected"] as const;
export type ConversionChallengeStatus = (typeof conversionChallengeStatusEnum)[number];

export const provisionalItemStatusEnum = [
  "pending",
  "approved",
  "rejected",
  "mapped_to_existing",
] as const;
export type ProvisionalItemStatus = (typeof provisionalItemStatusEnum)[number];

export const provisionalMappingTypeEnum = ["approved_new", "mapped_to_existing"] as const;
export type ProvisionalMappingType = (typeof provisionalMappingTypeEnum)[number];

export const workflowTypeEnum = [
  "item_reference_proposal",
  "provisional_item_proposal",
  "conversion_challenge",
  "reference_conflict",
] as const;
export type WorkflowType = (typeof workflowTypeEnum)[number];

// Re-export Prisma-generated row types
export type {
  Category,
  Subcategory,
  Item,
  ItemReference,
  ReferenceConflict,
  ItemReferenceProposal,
  ConversionChallenge,
  ProvisionalPartSequence,
  ProvisionalItem,
  ProvisionalItemMappingLog,
  WorkflowTransitionLog,
  OrgEvent,
} from "@/generated/prisma/client";

import type { Prisma } from "@/generated/prisma/client";
export type NewItem = Prisma.ItemUncheckedCreateInput;
export type NewItemReferenceProposal = Prisma.ItemReferenceProposalUncheckedCreateInput;
export type NewConversionChallenge = Prisma.ConversionChallengeUncheckedCreateInput;
export type NewProvisionalItem = Prisma.ProvisionalItemUncheckedCreateInput;
