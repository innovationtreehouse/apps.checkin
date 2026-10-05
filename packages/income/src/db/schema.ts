export type {
  PayoutImport,
  Payout,
  PayoutConflict,
  PayoutImportFile,
  ShopifyImportFile,
  ShopifyOrderBlob,
  ShopifyCustomer,
  ShopifyOrder,
  ShopifyOrderLineItem,
  PayoutDetailImportFile,
  ShopifyPayoutDetailBlob,
  ShopifyPayoutLineItem,
  IncomeAuditLog,
  PayoutReconciliation,
} from "../generated/prisma/client";

import type { Prisma } from "../generated/prisma/client";

export type NewPayoutImport = Prisma.PayoutImportUncheckedCreateInput;
export type NewPayout = Prisma.PayoutUncheckedCreateInput;
export type NewPayoutConflict = Prisma.PayoutConflictUncheckedCreateInput;
export type NewPayoutImportFile = Prisma.PayoutImportFileUncheckedCreateInput;
export type NewShopifyImportFile = Prisma.ShopifyImportFileUncheckedCreateInput;
export type NewShopifyOrderBlob = Prisma.ShopifyOrderBlobUncheckedCreateInput;
export type NewShopifyCustomer = Prisma.ShopifyCustomerUncheckedCreateInput;
export type NewShopifyOrder = Prisma.ShopifyOrderUncheckedCreateInput;
export type NewShopifyOrderLineItem = Prisma.ShopifyOrderLineItemUncheckedCreateInput;
export type NewPayoutDetailImportFile = Prisma.PayoutDetailImportFileUncheckedCreateInput;
export type NewShopifyPayoutDetailBlob = Prisma.ShopifyPayoutDetailBlobUncheckedCreateInput;
export type NewShopifyPayoutLineItem = Prisma.ShopifyPayoutLineItemUncheckedCreateInput;
export type NewIncomeAuditLog = Prisma.IncomeAuditLogUncheckedCreateInput;
