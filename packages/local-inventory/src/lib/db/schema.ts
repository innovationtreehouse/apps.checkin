// Re-export Prisma-generated model types under their original names.
// Workflow machines and other consumers import enum types from here.
export type {
  Location,
  OrgItem,
  InventoryLog,
  LocationLog,
  ReceiveQueue,
  SettingsData,
  ProvisionalItem,
  ProvisionalResolution,
  InventoryMergeConflict,
  ReceivedOrgEvent,
  ProvisionalItemLog,
  ReceivedInventoryDelta,
} from "@/generated/prisma/client";

// NOTE: these enum arrays are used for runtime validation in workflows.
export const inventoryChangeTypeEnum = ["manual", "automatic", "received"] as const;
export type InventoryChangeType = (typeof inventoryChangeTypeEnum)[number];

export const provisionalItemStatusEnum = ["pending", "approved", "rejected", "mapped_to_existing"] as const;
export type ProvisionalItemStatus = (typeof provisionalItemStatusEnum)[number];

export const mergeConflictTypeEnum = ["uom_mismatch"] as const;
export type MergeConflictType = (typeof mergeConflictTypeEnum)[number];

export const mergeConflictStatusEnum = ["pending", "resolved"] as const;
export type MergeConflictStatus = (typeof mergeConflictStatusEnum)[number];

export const receivedOrgEventStatusEnum = ["pending", "processed", "failed"] as const;
export type ReceivedOrgEventStatus = (typeof receivedOrgEventStatusEnum)[number];

export const receivedInventoryDeltaStatusEnum = ["applied", "failed"] as const;
export type ReceivedInventoryDeltaStatus = (typeof receivedInventoryDeltaStatusEnum)[number];
