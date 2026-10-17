/**
 * Integration test for the bulk-export capture + recovery path (F16). Skipped unless
 * SHOPIFY_READ_DATABASE_URL is set (and `prisma migrate deploy` has been run against it).
 */
import { it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../../src/db/client.js";
import { ingestBulkOrders, reingestBulkExports } from "../../src/ingest/bulkOrders.js";
import { ingestNode } from "../../src/ingest/ingestNode.js";
import { EventSource, ObjectType } from "../../src/generated/prisma/client.js";
import { describeDb } from "../helpers/db.js";

const STORE = "bulk-test.myshopify.com";

// One order with an INLINE refund, plus a line item as a separate __parentId line.
const JSONL = [
  JSON.stringify({
    id: "gid://shopify/Order/7001",
    name: "#7001",
    updatedAt: "2026-02-01T10:00:00Z",
    displayFinancialStatus: "PARTIALLY_REFUNDED",
    currentTotalPriceSet: { shopMoney: { amount: "100.00", currencyCode: "USD" } },
    refunds: [
      { id: "gid://shopify/Refund/8001", createdAt: "2026-02-02T00:00:00Z", totalRefundedSet: { shopMoney: { amount: "25.00", currencyCode: "USD" } } },
    ],
  }),
  JSON.stringify({
    id: "gid://shopify/LineItem/9001",
    __parentId: "gid://shopify/Order/7001",
    sku: "WIDGET-1",
    quantity: 2,
    originalUnitPriceSet: { shopMoney: { amount: "50.00", currencyCode: "USD" } },
  }),
].join("\n");

describeDb("bulk-export capture + recovery", () => {
  beforeEach(async () => {
    await prisma.shopifyBulkExport.deleteMany({ where: { storeId: STORE } });
    await prisma.shopifyRawEvent.deleteMany({ where: { storeId: STORE } });
    await prisma.shopRefund.deleteMany({ where: { storeId: STORE } });
    await prisma.shopOrderLine.deleteMany({ where: { storeId: STORE } });
    await prisma.shopOrder.deleteMany({ where: { storeId: STORE } });
  });
  afterAll(async () => {
    await prisma.shopifyBulkExport.deleteMany({ where: { storeId: STORE } });
    await prisma.shopifyRawEvent.deleteMany({ where: { storeId: STORE } });
    await prisma.shopRefund.deleteMany({ where: { storeId: STORE } });
    await prisma.shopOrderLine.deleteMany({ where: { storeId: STORE } });
    await prisma.shopOrder.deleteMany({ where: { storeId: STORE } });
    await prisma.$disconnect();
  });

  it("captures the verbatim JSONL and projects orders incl. the inline refund", async () => {
    const res = await ingestBulkOrders(prisma, {
      storeId: STORE,
      jsonl: JSONL,
      bulkOperationId: "gid://shopify/BulkOperation/1",
      source: EventSource.BACKFILL,
    });
    expect(res.ingested).toBe(1);

    const exp = await prisma.shopifyBulkExport.findFirst({ where: { storeId: STORE } });
    expect(exp?.jsonl).toBe(JSONL); // stored verbatim
    expect(await prisma.shopOrder.count({ where: { storeId: STORE } })).toBe(1);
    expect(await prisma.shopRefund.count({ where: { storeId: STORE } })).toBe(1); // F3: inline refund kept
    expect(await prisma.shopOrderLine.count({ where: { storeId: STORE } })).toBe(1);
  });

  it("a backfill snapshot ingested AFTER a newer incremental sync does not revert the order", async () => {
    // Incremental sync (between bulk STARTED and COMPLETED) projects the newer state…
    const newer = {
      id: "gid://shopify/Order/7001",
      name: "#7001",
      updatedAt: "2026-02-05T00:00:00Z",
      cancelledAt: "2026-02-05T00:00:00Z",
      displayFinancialStatus: "REFUNDED",
      totalRefundedSet: { shopMoney: { amount: "100.00", currencyCode: "USD" } },
      currentTotalPriceSet: { shopMoney: { amount: "100.00", currencyCode: "USD" } },
      lineItems: { nodes: [] },
      refunds: [],
    };
    await ingestNode(prisma, { storeId: STORE, objectType: ObjectType.ORDER, node: newer, source: EventSource.INCREMENTAL });
    // …then the older bulk snapshot (updatedAt 2026-02-01) lands, and is later re-ingested.
    await ingestBulkOrders(prisma, {
      storeId: STORE,
      jsonl: JSONL,
      bulkOperationId: "gid://shopify/BulkOperation/1",
      source: EventSource.BACKFILL,
    });
    await reingestBulkExports(prisma, { storeId: STORE });

    const row = await prisma.shopOrder.findUnique({
      where: { storeId_shopifyGid: { storeId: STORE, shopifyGid: "gid://shopify/Order/7001" } },
    });
    expect(row?.financialStatus).toBe("REFUNDED");
    expect(row?.totalRefundedCents).toBe(10000);
    expect(row?.cancelledAt).not.toBeNull();
  });

  it("recovers live tables from the stored export with NO Shopify calls", async () => {
    await ingestBulkOrders(prisma, {
      storeId: STORE,
      jsonl: JSONL,
      bulkOperationId: "gid://shopify/BulkOperation/1",
      source: EventSource.BACKFILL,
    });

    // Simulate live-table divergence: drop the projection but keep the export.
    await prisma.shopRefund.deleteMany({ where: { storeId: STORE } });
    await prisma.shopOrder.deleteMany({ where: { storeId: STORE } });
    expect(await prisma.shopOrder.count({ where: { storeId: STORE } })).toBe(0);

    const recovered = await reingestBulkExports(prisma, { storeId: STORE });
    expect(recovered.exports).toBe(1);
    expect(recovered.ingested).toBe(1);
    expect(await prisma.shopOrder.count({ where: { storeId: STORE } })).toBe(1); // restored from the blob
    expect(await prisma.shopRefund.count({ where: { storeId: STORE } })).toBe(1);
  });
});
