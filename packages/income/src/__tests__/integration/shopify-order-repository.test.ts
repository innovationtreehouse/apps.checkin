import { it, expect, beforeEach } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { createShopifyOrderRepository } from "../../repositories/shopify-order";
import { clearAll, ORG_A, ORG_B, newUserId } from "../helpers/fixtures";

const repo = createShopifyOrderRepository(db);

beforeEach(async () => {
  await clearAll();
});

// ── Helpers ────────────────────────────────────────────────────────────────────

async function seedImportFile(orgId: string) {
  return db.shopifyImportFile.create({
    data: {
      orgId,
      uploadedByUserId: newUserId(),
      originalFilename: "orders.csv",
      fileHash: Math.random().toString(36),
      rowCount: 1,
      newOrderCount: 1,
      skippedOrderCount: 0,
    },
  });
}

async function seedCustomer(orgId: string, email: string) {
  return db.shopifyCustomer.create({
    data: {
      orgId,
      email,
      billingName: "Jane Buyer",
      billingAddress1: "1 Main St",
      billingCity: "Townsville",
      billingZip: "12345",
      billingProvince: "CA",
      billingCountry: "US",
    },
  });
}

interface SeedOrderOpts {
  purchaseId?: string;
  paidAt?: string;
  totalCents?: number;
  email?: string;
}

async function seedOrder(orgId: string, opts: SeedOrderOpts = {}) {
  const purchaseId = opts.purchaseId ?? `#${Math.floor(Math.random() * 90000 + 10000)}`;
  const email = opts.email ?? "buyer@example.com";
  const importFile = await seedImportFile(orgId);
  const customer = await seedCustomer(orgId, email);

  const order = await db.shopifyOrder.create({
    data: {
      orgId,
      purchaseId,
      customerId: customer.id,
      financialStatus: "paid",
      paidAt: opts.paidAt ?? "2026-05-01 10:00:00",
      fulfillmentStatus: "fulfilled",
      currency: "USD",
      subtotalCents: 5000,
      shippingCents: 500,
      taxesCents: 400,
      totalCents: opts.totalCents ?? 5900,
      discountAmountCents: 0,
      refundedAmountCents: 0,
    },
  });

  await db.shopifyOrderBlob.create({
    data: {
      orgId,
      purchaseId,
      totalCents: opts.totalCents ?? 5900,
      payload: JSON.stringify({ purchaseId }),
      importFileId: importFile.id,
    },
  });

  return order;
}

async function seedLineItem(orgId: string, orderId: number) {
  return db.shopifyOrderLineItem.create({
    data: {
      orgId,
      orderId,
      quantity: 1,
      name: "Widget",
      priceCents: 5000,
      discountCents: 0,
    },
  });
}

// ── listOrders ─────────────────────────────────────────────────────────────────

describeDb("listOrders", () => {
  it("returns orders for the given org", async () => {
    await seedOrder(ORG_A, { purchaseId: "#1001" });
    const rows = await repo.listOrders(ORG_A, 1, 25);
    expect(rows).toHaveLength(1);
    expect(rows[0].purchaseId).toBe("#1001");
  });

  it("does not return orders from other orgs", async () => {
    await seedOrder(ORG_B, { purchaseId: "#2001" });
    const rows = await repo.listOrders(ORG_A, 1, 25);
    expect(rows).toHaveLength(0);
  });

  it("paginates correctly", async () => {
    await seedOrder(ORG_A, { purchaseId: "#1001", paidAt: "2026-05-01 10:00:00" });
    await seedOrder(ORG_A, { purchaseId: "#1002", paidAt: "2026-06-01 10:00:00", email: "b@example.com" });
    const page1 = await repo.listOrders(ORG_A, 1, 1);
    const page2 = await repo.listOrders(ORG_A, 2, 1);
    expect(page1).toHaveLength(1);
    expect(page2).toHaveLength(1);
    // Ordered by paidAt desc — #1002 first
    expect(page1[0].purchaseId).toBe("#1002");
    expect(page2[0].purchaseId).toBe("#1001");
  });

  it("includes email from joined customer", async () => {
    await seedOrder(ORG_A, { email: "specific@example.com" });
    const rows = await repo.listOrders(ORG_A, 1, 25);
    expect(rows[0].email).toBe("specific@example.com");
  });

  it("returns empty array when no orders", async () => {
    const rows = await repo.listOrders(ORG_A, 1, 25);
    expect(rows).toHaveLength(0);
  });
});

// ── countOrders ────────────────────────────────────────────────────────────────

describeDb("countOrders", () => {
  it("returns 0 when no orders", async () => {
    const [{ total }] = await repo.countOrders(ORG_A);
    expect(total).toBe(0);
  });

  it("counts only org-scoped orders", async () => {
    await seedOrder(ORG_A, { purchaseId: "#1001" });
    await seedOrder(ORG_A, { purchaseId: "#1002", email: "b@example.com" });
    await seedOrder(ORG_B, { purchaseId: "#2001" });
    const [{ total }] = await repo.countOrders(ORG_A);
    expect(total).toBe(2);
  });
});

// ── findOrderById ──────────────────────────────────────────────────────────────

describeDb("findOrderById", () => {
  it("returns the order when id and orgId match", async () => {
    const order = await seedOrder(ORG_A, { purchaseId: "#1001" });
    const rows = await repo.findOrderById(ORG_A, order.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].purchaseId).toBe("#1001");
  });

  it("returns empty when orgId does not match", async () => {
    const order = await seedOrder(ORG_A);
    const rows = await repo.findOrderById(ORG_B, order.id);
    expect(rows).toHaveLength(0);
  });

  it("returns empty when id does not exist", async () => {
    const rows = await repo.findOrderById(ORG_A, 99999);
    expect(rows).toHaveLength(0);
  });

  it("includes email and billing info from joined customer", async () => {
    const order = await seedOrder(ORG_A, { email: "detail@example.com" });
    const rows = await repo.findOrderById(ORG_A, order.id);
    expect(rows[0].email).toBe("detail@example.com");
    expect(rows[0].billingName).toBe("Jane Buyer");
  });

  it("includes payload from joined blob", async () => {
    const order = await seedOrder(ORG_A, { purchaseId: "#1001" });
    const rows = await repo.findOrderById(ORG_A, order.id);
    const payload = JSON.parse(rows[0].payload!);
    expect(payload.purchaseId).toBe("#1001");
  });
});

// ── findLineItemsByOrderId ─────────────────────────────────────────────────────

describeDb("findLineItemsByOrderId", () => {
  it("returns line items for matching order and org", async () => {
    const order = await seedOrder(ORG_A);
    await seedLineItem(ORG_A, order.id);
    await seedLineItem(ORG_A, order.id);
    const items = await repo.findLineItemsByOrderId(ORG_A, order.id);
    expect(items).toHaveLength(2);
    expect(items[0].name).toBe("Widget");
  });

  it("does not return line items from other orgs", async () => {
    const orderA = await seedOrder(ORG_A);
    const orderB = await seedOrder(ORG_B);
    await seedLineItem(ORG_B, orderB.id);
    const items = await repo.findLineItemsByOrderId(ORG_A, orderA.id);
    expect(items).toHaveLength(0);
  });

  it("returns empty when order has no line items", async () => {
    const order = await seedOrder(ORG_A);
    const items = await repo.findLineItemsByOrderId(ORG_A, order.id);
    expect(items).toHaveLength(0);
  });
});

// ── listImportFiles ────────────────────────────────────────────────────────────

describeDb("listImportFiles", () => {
  it("returns import files for org", async () => {
    await seedImportFile(ORG_A);
    const files = await repo.listImportFiles(ORG_A);
    expect(files).toHaveLength(1);
    expect(files[0].originalFilename).toBe("orders.csv");
  });

  it("does not return files from other orgs", async () => {
    await seedImportFile(ORG_B);
    const files = await repo.listImportFiles(ORG_A);
    expect(files).toHaveLength(0);
  });
});
