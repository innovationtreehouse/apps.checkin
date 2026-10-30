/**
 * Shared helpers for the DB-gated integration tests. Not a `*.test.ts` file, so vitest
 * does not collect it as a suite (include = test/**\/*.test.ts).
 */
import { type PrismaClient, ObjectType, EventSource } from "@checkin/s-ingest-core";

/** Remove every row this store owns across all tables the replay ops touch. */
export async function wipeStore(prisma: PrismaClient, storeId: string): Promise<void> {
  await prisma.shopifyRawEvent.deleteMany({ where: { storeId } });
  await prisma.shopifyBulkExport.deleteMany({ where: { storeId } });
  await prisma.shopOrderLine.deleteMany({ where: { storeId } });
  await prisma.shopRefund.deleteMany({ where: { storeId } });
  await prisma.shopOrder.deleteMany({ where: { storeId } });
  await prisma.shopBalanceTransaction.deleteMany({ where: { storeId } });
  await prisma.shopPayout.deleteMany({ where: { storeId } });
  await prisma.syncState.deleteMany({ where: { storeId } });
  await prisma.syncRun.deleteMany({ where: { storeId } });
}

/** A minimal, schema-valid order node (only `id` is strictly required). */
export function orderNode(gid: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: gid,
    legacyResourceId: gid.split("/").pop(),
    name: `#${gid.split("/").pop()}`,
    updatedAt: "2026-02-01T10:00:00Z",
    displayFinancialStatus: "PAID",
    currentTotalPriceSet: { shopMoney: { amount: "42.00", currencyCode: "USD" } },
    lineItems: { nodes: [] },
    refunds: [],
    ...overrides,
  };
}

/**
 * Build a `shopify_raw_event` create-input for an ORDER node. Sets the required columns
 * (storeId, objectType, shopifyGid, source, payload, payloadHash); occurredAt is optional.
 */
export function rawOrderEvent(
  storeId: string,
  gid: string,
  payload: Record<string, unknown>,
  opts: { occurredAt?: Date; hash?: string } = {},
) {
  return {
    storeId,
    objectType: ObjectType.ORDER,
    shopifyGid: gid,
    source: EventSource.TEST_LOADED,
    payload,
    payloadHash: opts.hash ?? `hash-${gid}-${JSON.stringify(payload).length}`,
    ...(opts.occurredAt ? { occurredAt: opts.occurredAt } : {}),
  };
}
