/**
 * Integration tests against a real Postgres. Skipped unless SHOPIFY_READ_DATABASE_URL is set
 * (and `prisma migrate deploy` has been run against it). In CI, point SHOPIFY_READ_DATABASE_URL
 * at a Testcontainers / local Postgres.
 *
 *   SHOPIFY_READ_DATABASE_URL=postgresql://... npm test
 */
import { it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../../src/db/client.js";
import { injectFixtures } from "../../src/ingest/inject.js";
import { ingestNode } from "../../src/ingest/ingestNode.js";
import { EventSource, ObjectType } from "../../src/generated/prisma/client.js";
import { describeDb } from "../helpers/db.js";

const STORE = "test-store.myshopify.com";

describeDb("projection into live tables (real Postgres)", () => {
  // Scope every delete to THIS suite's store so it never clobbers a sibling suite
  // running in parallel against the same database (vitest runs test files concurrently).
  const wipe = async () => {
    await prisma.shopifyRawEvent.deleteMany({ where: { storeId: STORE } });
    await prisma.shopOrderLine.deleteMany({ where: { storeId: STORE } });
    await prisma.shopRefund.deleteMany({ where: { storeId: STORE } });
    await prisma.shopOrder.deleteMany({ where: { storeId: STORE } });
    await prisma.shopBalanceTransaction.deleteMany({ where: { storeId: STORE } });
    await prisma.shopPayout.deleteMany({ where: { storeId: STORE } });
  };
  beforeEach(wipe);
  afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
  });

  const orderNode = (overrides: Record<string, unknown> = {}) => ({
    id: "gid://shopify/Order/1001",
    legacyResourceId: "1001",
    name: "#1001",
    email: "buyer@example.com",
    updatedAt: "2026-02-01T10:00:00Z",
    displayFinancialStatus: "PAID",
    currentTotalPriceSet: { shopMoney: { amount: "100.00", currencyCode: "USD" } },
    lineItems: { nodes: [{ id: "gid://shopify/LineItem/2001", sku: "WIDGET-1", quantity: 2, originalUnitPriceSet: { shopMoney: { amount: "50.00", currencyCode: "USD" } } }] },
    refunds: [],
    ...overrides,
  });

  it("is idempotent — ingesting the same order twice yields one row", async () => {
    const fixture = [{ objectType: ObjectType.ORDER, node: orderNode() }];
    await injectFixtures(prisma, fixture, { storeId: STORE, test: true });
    await injectFixtures(prisma, fixture, { storeId: STORE, test: true });

    expect(await prisma.shopOrder.count({ where: { storeId: STORE } })).toBe(1);
    expect(await prisma.shopOrderLine.count({ where: { storeId: STORE } })).toBe(1);
    // The identical re-read is not appended a second time.
    expect(await prisma.shopifyRawEvent.count({ where: { storeId: STORE, objectType: ObjectType.ORDER } })).toBe(1);
  });

  it("captures a status change on a later event (cancellation/refund)", async () => {
    await injectFixtures(prisma, [{ objectType: ObjectType.ORDER, node: orderNode() }], { storeId: STORE });
    await injectFixtures(
      prisma,
      [{ objectType: ObjectType.ORDER, node: orderNode({ updatedAt: "2026-03-01T00:00:00Z", cancelledAt: "2026-03-01T00:00:00Z", displayFinancialStatus: "REFUNDED" }) }],
      { storeId: STORE },
    );

    const row = await prisma.shopOrder.findUnique({
      where: { storeId_shopifyGid: { storeId: STORE, shopifyGid: "gid://shopify/Order/1001" } },
    });
    expect(row?.financialStatus).toBe("REFUNDED");
    expect(row?.cancelledAt).not.toBeNull();
    // A changed payload IS appended, so two raw events exist.
    expect(await prisma.shopifyRawEvent.count({ where: { storeId: STORE, objectType: ObjectType.ORDER } })).toBe(2);
  });

  it("stores signed balance transactions whose nets sum to the payout net", async () => {
    const fixtures = [
      { objectType: ObjectType.PAYOUT, node: { id: "gid://shopify/ShopifyPaymentsPayout/5001", net: { amount: "77.00", currencyCode: "USD" }, status: "PAID", issuedAt: "2026-02-05T00:00:00Z" } },
      { objectType: ObjectType.BALANCE_TXN, node: { id: "gid://shopify/ShopifyPaymentsBalanceTransaction/9001", type: "CHARGE", amount: { amount: "100.00", currencyCode: "USD" }, fee: { amount: "3.00" }, net: { amount: "97.00" }, associatedPayout: { id: "gid://shopify/ShopifyPaymentsPayout/5001" }, associatedOrder: { id: "gid://shopify/Order/1001" } } },
      { objectType: ObjectType.BALANCE_TXN, node: { id: "gid://shopify/ShopifyPaymentsBalanceTransaction/9002", type: "REFUND", amount: { amount: "-20.00", currencyCode: "USD" }, fee: { amount: "0.00" }, net: { amount: "-20.00" }, associatedPayout: { id: "gid://shopify/ShopifyPaymentsPayout/5001" }, associatedOrder: { id: "gid://shopify/Order/1001" } } },
    ];
    await injectFixtures(prisma, fixtures, { storeId: STORE });

    const payout = await prisma.shopPayout.findUnique({
      where: { storeId_payoutGid: { storeId: STORE, payoutGid: "gid://shopify/ShopifyPaymentsPayout/5001" } },
    });
    const txns = await prisma.shopBalanceTransaction.findMany({ where: { payoutGid: "gid://shopify/ShopifyPaymentsPayout/5001" } });
    const sum = txns.reduce((s, t) => s + t.netCents, 0);

    expect(payout?.netCents).toBe(7700);
    expect(sum).toBe(payout?.netCents);
    expect(txns.some((t) => t.netCents < 0)).toBe(true); // negative refund stored
  });

  it("tags injected rows by source in the append-only log", async () => {
    await injectFixtures(prisma, [{ objectType: ObjectType.ORDER, node: orderNode() }], { storeId: STORE, test: true });
    const events = await prisma.shopifyRawEvent.findMany({ where: { storeId: STORE } });
    expect(events).toHaveLength(1);
    expect(events[0].source).toBe(EventSource.TEST_LOADED);
  });

  const orderRow = () =>
    prisma.shopOrder.findUnique({
      where: { storeId_shopifyGid: { storeId: STORE, shopifyGid: "gid://shopify/Order/1001" } },
    });

  it("--test forces the order's test flag on and stamps TEST_LOADED on the live row", async () => {
    await injectFixtures(prisma, [{ objectType: ObjectType.ORDER, node: orderNode({ test: false }) }], {
      storeId: STORE,
      test: true,
    });
    expect(await orderRow()).toMatchObject({ test: true, source: EventSource.TEST_LOADED });
  });

  it("stamps HAND_LOADED on injected payouts and balance transactions", async () => {
    await injectFixtures(
      prisma,
      [
        { objectType: ObjectType.PAYOUT, node: { id: "gid://shopify/ShopifyPaymentsPayout/5001", net: { amount: "1.00", currencyCode: "USD" } } },
        { objectType: ObjectType.BALANCE_TXN, node: { id: "gid://shopify/ShopifyPaymentsBalanceTransaction/9001", type: "CHARGE", amount: { amount: "1.00", currencyCode: "USD" }, fee: { amount: "0.00" }, net: { amount: "1.00" } } },
      ],
      { storeId: STORE },
    );
    expect((await prisma.shopPayout.findFirst({ where: { storeId: STORE } }))?.source).toBe(EventSource.HAND_LOADED);
    expect((await prisma.shopBalanceTransaction.findFirst({ where: { storeId: STORE } }))?.source).toBe(EventSource.HAND_LOADED);
  });

  it("an API re-ingest of the same gid restamps a hand-loaded row", async () => {
    await injectFixtures(prisma, [{ objectType: ObjectType.ORDER, node: orderNode({ email: "fixture@example.com" }) }], {
      storeId: STORE,
    });
    expect((await orderRow())?.source).toBe(EventSource.HAND_LOADED);

    await ingestNode(prisma, { storeId: STORE, objectType: ObjectType.ORDER, node: orderNode(), source: EventSource.INCREMENTAL });
    expect(await orderRow()).toMatchObject({ source: EventSource.INCREMENTAL, customerEmail: "buyer@example.com" });
  });

  it("refuses an inject that reuses the GID of an API-synced row, writing nothing", async () => {
    await ingestNode(prisma, { storeId: STORE, objectType: ObjectType.ORDER, node: orderNode(), source: EventSource.BACKFILL });
    const fixtures = [
      { objectType: ObjectType.PAYOUT, node: { id: "gid://shopify/ShopifyPaymentsPayout/5001", net: { amount: "1.00", currencyCode: "USD" } } },
      { objectType: ObjectType.ORDER, node: orderNode({ email: "fixture@example.com", updatedAt: "2030-01-01T00:00:00Z" }) },
    ];

    await expect(injectFixtures(prisma, fixtures, { storeId: STORE })).rejects.toThrow(/gid:\/\/shopify\/Order\/1001/);
    expect(await orderRow()).toMatchObject({ source: EventSource.BACKFILL, customerEmail: "buyer@example.com" });
    expect(await prisma.shopPayout.count({ where: { storeId: STORE } })).toBe(0);
    expect(await prisma.shopifyRawEvent.count({ where: { storeId: STORE } })).toBe(1);
  });

  it("re-injecting a hand-loaded GID is allowed", async () => {
    const fixture = [{ objectType: ObjectType.ORDER, node: orderNode() }];
    await injectFixtures(prisma, fixture, { storeId: STORE });
    await expect(
      injectFixtures(prisma, [{ objectType: ObjectType.ORDER, node: orderNode({ name: "#fixed" }) }], { storeId: STORE }),
    ).resolves.toHaveLength(1);
    expect((await orderRow())?.name).toBe("#fixed");
  });
});
