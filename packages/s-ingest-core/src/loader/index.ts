/**
 * Dispatch a single validated node to the correct projector. Used by both the
 * live sync and the inject path so projection logic has one home.
 *
 * IDEMPOTENCY CONTRACT (load-bearing): every projector here upserts by a stable natural key
 * — (storeId, shopifyGid) for orders/payouts/balance txns, (storeId, refundGid) for refunds.
 * This is what makes the whole fleet's at-least-once processing safe: re-invoke, replay, and
 * concurrent-overlap all re-project the same nodes and converge to the same live state. Do NOT
 * change a projector to a create/insert or a non-natural key without preserving this property.
 *
 * ORDERING CONTRACT: orders are newest-wins on Shopify's `updatedAt` (see projectOrder), so the
 * order in which order nodes arrive does not matter. Payouts and balance transactions carry no
 * Shopify version field; they are only ever fetched live (never bulk-exported), so their raw-log
 * id order is fetch order and last-write-wins is newest-wins.
 */
import type { DbClient } from "../ingest/rawLog.js";
import { ObjectType } from "../generated/prisma/client.js";
import {
  orderNodeSchema,
  payoutNodeSchema,
  balanceTxnNodeSchema,
  refundSchemaWithOrder,
  normalizeOrder,
  normalizePayout,
  normalizeBalanceTxn,
  normalizeStandaloneRefund,
} from "../shopify/schemas.js";
import { projectOrder } from "./projectOrders.js";
import { projectPayout, projectBalanceTxn } from "./projectPayouts.js";

export async function projectNode(
  db: DbClient,
  storeId: string,
  objectType: ObjectType,
  node: unknown,
): Promise<void> {
  switch (objectType) {
    case ObjectType.ORDER:
      await projectOrder(db, storeId, normalizeOrder(orderNodeSchema.parse(node)));
      return;
    case ObjectType.PAYOUT:
      await projectPayout(db, storeId, normalizePayout(payoutNodeSchema.parse(node)));
      return;
    case ObjectType.BALANCE_TXN:
      await projectBalanceTxn(db, storeId, normalizeBalanceTxn(balanceTxnNodeSchema.parse(node)));
      return;
    case ObjectType.REFUND: {
      const r = normalizeStandaloneRefund(refundSchemaWithOrder.parse(node));
      const fields = {
        orderGid: r.orderGid,
        storeId,
        createdAt: r.createdAt,
        totalRefundedCents: r.totalRefundedCents,
        note: r.note ?? null,
      };
      await db.shopRefund.upsert({
        where: { storeId_refundGid: { storeId, refundGid: r.refundGid } },
        create: { refundGid: r.refundGid, ...fields },
        update: fields,
      });
      return;
    }
    default:
      throw new Error(`Unsupported object type: ${objectType}`);
  }
}
