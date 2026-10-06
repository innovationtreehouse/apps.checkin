/**
 * Project a normalized order into the live tables: shop_order, shop_order_line,
 * shop_refund. Idempotent and newest-wins on Shopify's `updatedAt`: a node whose
 * `updatedAt` is older than the stored row's is skipped entirely (order AND its
 * lines/refunds), so a stale bulk snapshot, re-ingested export, or replayed event
 * can never revert financial status, refunds, or cancellation. Equal `updatedAt`
 * re-writes, which keeps same-version re-projection idempotent.
 */
import type { DbClient } from "../ingest/rawLog.js";
import type { NormalizedOrder } from "../shopify/schemas.js";

export async function projectOrder(db: DbClient, storeId: string, order: NormalizedOrder): Promise<void> {
  const fields = {
    storeId,
    legacyId: order.legacyId ?? null,
    name: order.name ?? null,
    customerEmail: order.customerEmail ?? null,
    customerName: order.customerName ?? null,
    financialStatus: order.financialStatus ?? null,
    fulfillmentStatus: order.fulfillmentStatus ?? null,
    createdAt: order.createdAt,
    processedAt: order.processedAt,
    updatedAt: order.updatedAt,
    cancelledAt: order.cancelledAt,
    currency: order.currency ?? null,
    subtotalCents: order.subtotalCents,
    shippingCents: order.shippingCents,
    taxCents: order.taxCents,
    discountCents: order.discountCents,
    totalCents: order.totalCents,
    totalRefundedCents: order.totalRefundedCents,
    test: order.test,
    noteAttributes: order.noteAttributes ?? undefined,
    discountCodes: order.discountCodes,
    lastSyncedAt: new Date(),
  };

  // Insert-if-absent, then a guarded update. The UPDATE's WHERE is re-checked under the
  // row lock, so a concurrent newer write can't be clobbered between read and write.
  const { count: created } = await db.shopOrder.createMany({
    data: [{ shopifyGid: order.shopifyGid, ...fields }],
    skipDuplicates: true,
  });
  if (created === 0) {
    const { count: updated } = await db.shopOrder.updateMany({
      where: {
        storeId,
        shopifyGid: order.shopifyGid,
        OR: order.updatedAt ? [{ updatedAt: null }, { updatedAt: { lte: order.updatedAt } }] : [{ updatedAt: null }],
      },
      data: fields,
    });
    if (updated === 0) return; // stored row is newer — leave it and its children alone
  }

  // Reconcile line items by GID: upsert present ones, soft-mark absent ones.
  const incoming = new Set(order.lines.map((l) => l.lineGid));
  for (const line of order.lines) {
    const lineFields = {
      orderGid: order.shopifyGid,
      storeId,
      sku: line.sku ?? null,
      title: line.title ?? null,
      quantity: line.quantity,
      variantGid: line.variantGid ?? null,
      variantLegacyId: line.variantLegacyId ?? null,
      priceCents: line.priceCents,
      discountCents: line.discountCents,
      removed: false,
    };
    await db.shopOrderLine.upsert({
      where: { storeId_lineGid: { storeId, lineGid: line.lineGid } },
      create: { lineGid: line.lineGid, ...lineFields },
      update: lineFields,
    });
  }
  const existing = await db.shopOrderLine.findMany({
    where: { storeId, orderGid: order.shopifyGid },
    select: { lineGid: true },
  });
  const toRemove = existing.map((e) => e.lineGid).filter((gid) => !incoming.has(gid));
  if (toRemove.length > 0) {
    await db.shopOrderLine.updateMany({
      where: { storeId, lineGid: { in: toRemove } },
      data: { removed: true },
    });
  }

  // Refunds are append/update-only (never disappear from an order).
  for (const refund of order.refunds) {
    const refundFields = {
      orderGid: refund.orderGid,
      storeId,
      createdAt: refund.createdAt,
      totalRefundedCents: refund.totalRefundedCents,
      note: refund.note ?? null,
    };
    await db.shopRefund.upsert({
      where: { storeId_refundGid: { storeId, refundGid: refund.refundGid } },
      create: { refundGid: refund.refundGid, ...refundFields },
      update: refundFields,
    });
  }
}
