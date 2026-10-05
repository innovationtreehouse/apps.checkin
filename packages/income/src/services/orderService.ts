import { db } from "../db";
import { createShopifyOrderRepository } from "../repositories/shopify-order";
import { importShopifyOrders } from "../lib/shopify-order-import";
import type { ParsedOrder } from "../lib/shopify-order-csv-parser";

const repo = createShopifyOrderRepository(db);

export const orderService = {
  async listOrders(orgId: string, page: number, pageSize: number) {
    const [rows, [{ total }]] = await Promise.all([
      repo.listOrders(orgId, page, pageSize),
      repo.countOrders(orgId),
    ]);
    return { orders: rows, total };
  },

  async getOrder(orgId: string, id: number) {
    const rows = await repo.findOrderById(orgId, id);
    if (rows.length === 0) return null;
    const lineItems = await repo.findLineItemsByOrderId(orgId, id);
    return { order: rows[0], lineItems };
  },

  async listImportFiles(orgId: string) {
    return repo.listImportFiles(orgId);
  },

  async importOrders(
    orgId: string,
    userId: number,
    filename: string,
    buffer: Buffer,
    parsedOrders: Map<string, ParsedOrder>,
    correlationId?: string,
    username?: string,
  ) {
    return importShopifyOrders(orgId, userId, filename, buffer, parsedOrders, correlationId, username);
  },
};
