import type { PrismaClient } from "../generated/prisma/client";

export function createShopifyOrderRepository(db: PrismaClient) {
  return {
    async listOrders(orgId: string, page: number, pageSize: number) {
      const offset = (page - 1) * pageSize;
      const rows = await db.shopifyOrder.findMany({
        where: { orgId },
        include: { customer: { select: { email: true } } },
        orderBy: { paidAt: "desc" },
        skip: offset,
        take: pageSize,
      });
      return rows.map((r) => ({
        id: r.id,
        purchaseId: r.purchaseId,
        paidAt: r.paidAt,
        financialStatus: r.financialStatus,
        totalCents: r.totalCents,
        email: r.customer.email,
        importedAt: r.importedAt,
      }));
    },

    async countOrders(orgId: string) {
      const total = await db.shopifyOrder.count({ where: { orgId } });
      return [{ total }];
    },

    async findOrderById(orgId: string, id: number) {
      const r = await db.shopifyOrder.findFirst({
        where: { orgId, id },
        include: { customer: true },
      });
      if (!r) return [];

      const blob = await db.shopifyOrderBlob.findFirst({
        where: { orgId, purchaseId: r.purchaseId },
        select: { payload: true },
      });

      return [{
        id: r.id,
        orgId: r.orgId,
        purchaseId: r.purchaseId,
        shopifyNumericId: r.shopifyNumericId,
        financialStatus: r.financialStatus,
        paidAt: r.paidAt,
        fulfillmentStatus: r.fulfillmentStatus,
        fulfilledAt: r.fulfilledAt,
        cancelledAt: r.cancelledAt,
        createdAt: r.createdAt,
        currency: r.currency,
        subtotalCents: r.subtotalCents,
        shippingCents: r.shippingCents,
        taxesCents: r.taxesCents,
        totalCents: r.totalCents,
        discountCode: r.discountCode,
        discountAmountCents: r.discountAmountCents,
        refundedAmountCents: r.refundedAmountCents,
        importedAt: r.importedAt,
        email: r.customer.email,
        billingName: r.customer.billingName,
        billingAddress1: r.customer.billingAddress1,
        billingAddress2: r.customer.billingAddress2,
        billingCity: r.customer.billingCity,
        billingZip: r.customer.billingZip,
        billingProvince: r.customer.billingProvince,
        billingCountry: r.customer.billingCountry,
        payload: blob?.payload ?? null,
      }];
    },

    findLineItemsByOrderId(orgId: string, orderId: number) {
      return db.shopifyOrderLineItem.findMany({
        where: { orgId, orderId },
        orderBy: { id: "asc" },
      });
    },

    listImportFiles(orgId: string) {
      return db.shopifyImportFile.findMany({
        where: { orgId },
        orderBy: { uploadedAt: "desc" },
      });
    },
  };
}

export type ShopifyOrderRepository = ReturnType<typeof createShopifyOrderRepository>;
