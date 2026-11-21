/**
 * Integration tests for the inject path (real Postgres): injectFile reads + validates a
 * fixture file and projects it exactly like an API ingest (tagged in the raw log), and the
 * standalone-REFUND projector writes a shop_refund that names its order. Skipped unless
 * SHOPIFY_READ_DATABASE_URL is set.
 */
import { fileURLToPath } from "node:url";
import { it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../../src/db/client.js";
import { injectFile, injectFixtures } from "../../src/ingest/inject.js";
import { EventSource, ObjectType } from "../../src/generated/prisma/client.js";
import { describeDb } from "../helpers/db.js";

const STORE = "inject-test.myshopify.com";
const payoutFixture = fileURLToPath(new URL("../fixtures/payout-with-refund.json", import.meta.url));

describeDb("inject path", () => {
  beforeEach(async () => {
    await prisma.shopifyRawEvent.deleteMany({ where: { storeId: STORE } });
    await prisma.shopRefund.deleteMany({ where: { storeId: STORE } });
    await prisma.shopBalanceTransaction.deleteMany({ where: { storeId: STORE } });
    await prisma.shopPayout.deleteMany({ where: { storeId: STORE } });
  });
  afterAll(async () => {
    await prisma.shopifyRawEvent.deleteMany({ where: { storeId: STORE } });
    await prisma.shopRefund.deleteMany({ where: { storeId: STORE } });
    await prisma.shopBalanceTransaction.deleteMany({ where: { storeId: STORE } });
    await prisma.shopPayout.deleteMany({ where: { storeId: STORE } });
    await prisma.$disconnect();
  });

  it("injectFile reads an array fixture and projects every node, tagged TEST_LOADED", async () => {
    const results = await injectFile(prisma, payoutFixture, { storeId: STORE, test: true });
    expect(results).toHaveLength(3); // 1 payout + 2 balance txns

    const payout = await prisma.shopPayout.findUnique({
      where: { storeId_payoutGid: { storeId: STORE, payoutGid: "gid://shopify/ShopifyPaymentsPayout/5001" } },
    });
    expect(payout?.netCents).toBe(7700);
    expect(await prisma.shopBalanceTransaction.count({ where: { storeId: STORE } })).toBe(2);

    const events = await prisma.shopifyRawEvent.findMany({ where: { storeId: STORE } });
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.source === EventSource.TEST_LOADED)).toBe(true);
  });

  it("refuses a fixture stamped in the future, writing nothing", async () => {
    const node = {
      id: "gid://shopify/ShopifyPaymentsPayout/5099",
      issuedAt: "2999-01-01T00:00:00Z",
      net: { amount: "1.00", currencyCode: "USD" },
    };
    await expect(injectFixtures(prisma, [{ objectType: ObjectType.PAYOUT, node }], { storeId: STORE })).rejects.toThrow(
      /stamped in the future: gid:\/\/shopify\/ShopifyPaymentsPayout\/5099/,
    );
    expect(await prisma.shopifyRawEvent.count({ where: { storeId: STORE } })).toBe(0);
  });

  it("projects a standalone REFUND node into shop_refund, keyed to its order", async () => {
    await injectFixtures(
      prisma,
      [
        {
          objectType: ObjectType.REFUND,
          node: {
            id: "gid://shopify/Refund/3001",
            orderGid: "gid://shopify/Order/1001",
            createdAt: "2026-02-02T00:00:00Z",
            totalRefundedSet: { shopMoney: { amount: "25.00", currencyCode: "USD" } },
            note: "customer changed mind",
          },
        },
      ],
      { storeId: STORE },
    );

    const refund = await prisma.shopRefund.findUnique({
      where: { storeId_refundGid: { storeId: STORE, refundGid: "gid://shopify/Refund/3001" } },
    });
    expect(refund?.orderGid).toBe("gid://shopify/Order/1001");
    expect(refund?.totalRefundedCents).toBe(2500);
    expect(refund?.note).toBe("customer changed mind");
  });
});
