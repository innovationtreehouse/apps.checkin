/**
 * Integration test for order line-item reconciliation (real Postgres). projectOrder upserts
 * the lines present on the incoming node and SOFT-marks (removed=true) any line that was on a
 * prior version of the order but is absent now — lines are never hard-deleted. Skipped unless
 * SHOPIFY_READ_DATABASE_URL is set.
 */
import { it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../../src/db/client.js";
import { injectFixtures } from "../../src/ingest/inject.js";
import { ObjectType } from "../../src/generated/prisma/client.js";
import { describeDb } from "../helpers/db.js";

const STORE = "projlines-test.myshopify.com";
const ORDER = "gid://shopify/Order/4001";
const LINE_A = "gid://shopify/LineItem/5001";
const LINE_B = "gid://shopify/LineItem/5002";

type LineSpec = { id: string; sku: string; quantity?: number; currentQuantity?: number };

const line = ({ id, sku, quantity = 1, currentQuantity }: LineSpec) => ({
  id,
  sku,
  quantity,
  ...(currentQuantity === undefined ? {} : { currentQuantity }),
  originalUnitPriceSet: { shopMoney: { amount: "10.00", currencyCode: "USD" } },
});

const orderWith = (lineIds: LineSpec[]) => ({
  id: ORDER,
  legacyResourceId: "4001",
  name: "#4001",
  updatedAt: "2026-02-01T10:00:00Z",
  displayFinancialStatus: "PAID",
  currentTotalPriceSet: { shopMoney: { amount: "20.00", currencyCode: "USD" } },
  lineItems: { nodes: lineIds.map(line) },
  refunds: [],
});

describeDb("projectOrder line reconciliation", () => {
  beforeEach(async () => {
    await prisma.shopifyRawEvent.deleteMany({ where: { storeId: STORE } });
    await prisma.shopOrderLine.deleteMany({ where: { storeId: STORE } });
    await prisma.shopOrder.deleteMany({ where: { storeId: STORE } });
  });
  afterAll(async () => {
    await prisma.shopifyRawEvent.deleteMany({ where: { storeId: STORE } });
    await prisma.shopOrderLine.deleteMany({ where: { storeId: STORE } });
    await prisma.shopOrder.deleteMany({ where: { storeId: STORE } });
    await prisma.$disconnect();
  });

  it("soft-marks a line that disappears on a later version, without hard-deleting it", async () => {
    // v1: two lines.
    await injectFixtures(
      prisma,
      [{ objectType: ObjectType.ORDER, node: orderWith([{ id: LINE_A, sku: "A" }, { id: LINE_B, sku: "B" }]) }],
      { storeId: STORE },
    );
    // v2: line B is gone.
    await injectFixtures(prisma, [{ objectType: ObjectType.ORDER, node: orderWith([{ id: LINE_A, sku: "A" }]) }], {
      storeId: STORE,
    });

    const a = await prisma.shopOrderLine.findUnique({ where: { storeId_lineGid: { storeId: STORE, lineGid: LINE_A } } });
    const b = await prisma.shopOrderLine.findUnique({ where: { storeId_lineGid: { storeId: STORE, lineGid: LINE_B } } });

    expect(a?.removed).toBe(false); // still present
    expect(b).not.toBeNull(); // NOT hard-deleted
    expect(b?.removed).toBe(true); // soft-marked
    // Both rows still exist on the order.
    expect(await prisma.shopOrderLine.count({ where: { storeId: STORE, orderGid: ORDER } })).toBe(2);
  });

  it("stores the current quantity next to the original, and null when the payload has none", async () => {
    const node = orderWith([{ id: LINE_A, sku: "A", quantity: 2, currentQuantity: 1 }, { id: LINE_B, sku: "B" }]);
    await injectFixtures(prisma, [{ objectType: ObjectType.ORDER, node }], { storeId: STORE });

    const a = await prisma.shopOrderLine.findUnique({ where: { storeId_lineGid: { storeId: STORE, lineGid: LINE_A } } });
    const b = await prisma.shopOrderLine.findUnique({ where: { storeId_lineGid: { storeId: STORE, lineGid: LINE_B } } });
    expect(a).toMatchObject({ quantity: 2, currentQuantity: 1 });
    expect(b).toMatchObject({ quantity: 1, currentQuantity: null });
  });

  it("un-marks a line that reappears on a still-later version", async () => {
    await injectFixtures(
      prisma,
      [{ objectType: ObjectType.ORDER, node: orderWith([{ id: LINE_A, sku: "A" }, { id: LINE_B, sku: "B" }]) }],
      { storeId: STORE },
    );
    await injectFixtures(prisma, [{ objectType: ObjectType.ORDER, node: orderWith([{ id: LINE_A, sku: "A" }]) }], {
      storeId: STORE,
    });
    // v3: B is back.
    await injectFixtures(
      prisma,
      [{ objectType: ObjectType.ORDER, node: orderWith([{ id: LINE_A, sku: "A" }, { id: LINE_B, sku: "B" }]) }],
      { storeId: STORE },
    );

    const b = await prisma.shopOrderLine.findUnique({ where: { storeId_lineGid: { storeId: STORE, lineGid: LINE_B } } });
    expect(b?.removed).toBe(false); // reinstated
  });
});
