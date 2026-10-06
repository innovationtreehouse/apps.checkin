export type { LineItemApprovalStatus } from "@inventory/receipt-types";

export type ExpenseState =
  | "pending"
  | "assign_ownership"
  | "owner_approval"
  | "capital_review"
  | "set_depreciation_cycle"
  | "qb_pending"
  | "qb_on_hold"
  | "qb_error"
  | "qb_complete"
  | "qb_skipped"
  | "rejected";

export const provisionalItemMapStatusEnum = ["pending", "approved", "rejected", "mapped_to_existing"] as const;
export type ProvisionalItemMapStatus = (typeof provisionalItemMapStatusEnum)[number];

export const receivedExpensePayloadStatusEnum = ["applied", "failed"] as const;
export type ReceivedExpensePayloadStatus = (typeof receivedExpensePayloadStatusEnum)[number];

export const receivedOrgEventStatusEnum = ["pending", "processed", "failed"] as const;
export type ReceivedOrgEventStatus = (typeof receivedOrgEventStatusEnum)[number];

export const qbMatchStateEnum = ["UNMATCHED", "MATCHED", "CREATED", "AMBIGUOUS", "BEFORE_LINE", "POST_FAILED"] as const;
export type QbMatchState = (typeof qbMatchStateEnum)[number];

export type {
  ExpenseOrgSettings,
  Expense,
  ExpenseLineItem,
  LineItemOwnerApproval,
  AccountMapping,
  ExpenseHold,
  ExpenseEvent,
  ExpenseQbAccount,
  ExpenseAuditLog,
  PartOwnerMap,
  ProvisionalItemMap,
  ExpenseProvisionalResolution,
  ExpenseReceivedOrgEvent,
  ReceivedExpensePayload,
  CapitalAsset,
  ExpenseQbMatchExclusion,
  ExpenseLineSignoff,
  ExpenseFlag,
} from "../generated/prisma/client";

import type { Prisma } from "../generated/prisma/client";

export type NewExpense = Prisma.ExpenseUncheckedCreateInput;
export type NewExpenseLineItem = Prisma.ExpenseLineItemUncheckedCreateInput;
export type NewExpenseAuditLog = Prisma.ExpenseAuditLogUncheckedCreateInput;
export type NewAccountMapping = Prisma.AccountMappingCreateInput;
export type NewExpenseQbAccount = Prisma.ExpenseQbAccountCreateInput;
export type NewProvisionalItemMap = Prisma.ProvisionalItemMapCreateInput;
export type NewProvisionalResolution = Prisma.ExpenseProvisionalResolutionCreateInput;
export type NewReceivedOrgEvent = Prisma.ExpenseReceivedOrgEventCreateInput;
export type NewReceivedExpensePayload = Prisma.ReceivedExpensePayloadUncheckedCreateInput;
