import { it, expect, beforeEach } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { importShopifyOrders } from "../../lib/shopify-order-import";
import { clearAll, orderMap, ORG_A, ORG_B, newUserId } from "../helpers/fixtures";

const buf = Buffer.from("orders-csv-bytes");

beforeEach(async () => {
  await clearAll();
});

describeDb("importShopifyOrders — inserts & dedup", () => {
  it("imports a new order", async () => {
    const summary = await importShopifyOrders(ORG_A, newUserId(), "orders.csv", buf, orderMap({ name: "#1001" }));
    expect(summary.imported).toBe(1);
    expect(summary.skipped).toBe(0);
    expect(summary.total).toBe(1);

    const orders = await db.shopifyOrder.findMany({ where: { orgId: ORG_A } });
    expect(orders.length).toBe(1);
    expect(orders[0].purchaseId).toBe("#1001");
  });

  it("skips an order whose purchaseId was already imported", async () => {
    await importShopifyOrders(ORG_A, newUserId(), "a.csv", buf, orderMap({ name: "#1001" }));
    const summary = await importShopifyOrders(ORG_A, newUserId(), "b.csv", buf, orderMap({ name: "#1001" }));
    expect(summary.imported).toBe(0);
    expect(summary.skipped).toBe(1);

    const blobs = await db.shopifyOrderBlob.findMany({ where: { orgId: ORG_A } });
    expect(blobs.length).toBe(1);
  });

  it("imports two distinct orders in one batch", async () => {
    const summary = await importShopifyOrders(ORG_A, newUserId(), "x.csv", buf, orderMap(
      { name: "#1001" },
      { name: "#1002" },
    ));
    expect(summary.imported).toBe(2);
  });
});

describeDb("importShopifyOrders — customer dedup", () => {
  it("reuses one customer row for two orders with the same email", async () => {
    await importShopifyOrders(ORG_A, newUserId(), "x.csv", buf, orderMap(
      { name: "#1001", overrides: { email: "same@example.com" } },
      { name: "#1002", overrides: { email: "same@example.com" } },
    ));
    const customers = await db.shopifyCustomer.findMany({ where: { orgId: ORG_A } });
    expect(customers.length).toBe(1);
  });
});

describeDb("importShopifyOrders — org isolation", () => {
  it("same purchaseId in two orgs both import (no cross-org dedup)", async () => {
    await importShopifyOrders(ORG_A, newUserId(), "x.csv", buf, orderMap({ name: "#1001" }));
    const summary = await importShopifyOrders(ORG_B, newUserId(), "y.csv", buf, orderMap({ name: "#1001" }));
    expect(summary.imported).toBe(1);
    expect(summary.skipped).toBe(0);

    expect((await db.shopifyOrder.findMany({ where: { orgId: ORG_A } })).length).toBe(1);
    expect((await db.shopifyOrder.findMany({ where: { orgId: ORG_B } })).length).toBe(1);
  });
});
