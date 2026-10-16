/**
 * Integration test for reingestBulk() — re-reassembles + re-projects stored bulk
 * exports with no Shopify calls. Skipped unless SHOPIFY_READ_DATABASE_URL is set.
 */
import { it, expect, beforeEach, afterAll } from "vitest";
import { describeDb } from "@inventory/pg-test-harness";
import { prisma, ingestBulkOrders, EventSource } from "@inventory/s-ingest-core";
import { reingestBulk } from "../../src/replay.js";
import { wipeStore, orderNode } from "./helpers.js";

const STORE = "reingest-test.myshopify.com";
const run = describeDb("SHOPIFY_READ_DATABASE_URL");

run("s-replay-function reingestBulk", () => {
  beforeEach(() => wipeStore(prisma, STORE));
  afterAll(async () => {
    await wipeStore(prisma, STORE);
    await prisma.$disconnect();
  });

  it("rebuilds the live order from the persisted bulk export (no Shopify call)", async () => {
    const gid = "gid://shopify/Order/8001";
    const jsonl = JSON.stringify(orderNode(gid)); // one top-level order record

    const seed = await ingestBulkOrders(prisma, {
      storeId: STORE,
      jsonl,
      bulkOperationId: "gid://shopify/BulkOperation/42",
      source: EventSource.BACKFILL,
    });
    expect(seed.ingested).toBe(1);
    expect(await prisma.shopOrder.count({ where: { storeId: STORE } })).toBe(1);

    // Simulate live-table loss; the verbatim export (and its raw events) survive.
    await prisma.shopOrder.deleteMany({ where: { storeId: STORE } });
    expect(await prisma.shopOrder.count({ where: { storeId: STORE } })).toBe(0);

    const result = await reingestBulk(prisma, { storeId: STORE, actor: "test", reason: "repair backfill" });
    expect(result.exports).toBeGreaterThanOrEqual(1);
    expect(result.ingested).toBeGreaterThanOrEqual(1);

    const restored = await prisma.shopOrder.findUnique({
      where: { storeId_shopifyGid: { storeId: STORE, shopifyGid: gid } },
    });
    expect(restored).not.toBeNull();

    // Recorded as an ADMIN run for audit.
    const adminRun = await prisma.syncRun.findFirst({
      where: { storeId: STORE, kind: "ADMIN", objectScope: "reingest-bulk" },
      orderBy: { id: "desc" },
    });
    expect(adminRun?.status).toBe("COMPLETED");
    expect(adminRun?.actor).toBe("test");
  });
});
