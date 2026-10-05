import { it, expect, beforeEach } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { importPayoutDetails } from "../../lib/payout-detail-import";
import { clearAll, seedPayout, ORG_A, ORG_B, newUserId } from "../helpers/fixtures";
import type { ShopifyPayoutDetailRow } from "../../lib/shopify-payout-detail-schemas";

beforeEach(async () => {
  await clearAll();
});

function makeDetailRow(overrides: Partial<ShopifyPayoutDetailRow> = {}): ShopifyPayoutDetailRow {
  return {
    transactionDate: "2026-05-01",
    transactionType: "charge",
    orderRef: "#1001",
    payoutStatus: "paid",
    payoutDate: "2026-05-01",
    shopifyPayoutId: "PAY-001",
    amount: 59,
    fee: -1.5,
    net: 57.5,
    currency: "USD",
    ...overrides,
  };
}

function rowMap(payoutId: string, ...rows: ShopifyPayoutDetailRow[]): Map<string, ShopifyPayoutDetailRow[]> {
  return new Map([[payoutId, rows]]);
}

// import_file_id is NOT NULL — importPayoutDetails always requires metadata
function meta(filename = "test.csv") {
  return { userId: newUserId(), filename, buffer: Buffer.from("csv-data") };
}

describeDb("importPayoutDetails — inserts", () => {
  it("inserts a new detail blob and line item", async () => {
    const summary = await importPayoutDetails(ORG_A, rowMap("PAY-001", makeDetailRow()), meta());
    expect(summary.inserted).toBe(1);
    expect(summary.duplicate).toBe(0);
    expect(summary.payoutIds).toEqual(["PAY-001"]);

    const blobs = await db.shopifyPayoutDetailBlob.findMany({ where: { orgId: ORG_A } });
    expect(blobs).toHaveLength(1);
    expect(blobs[0].shopifyPayoutId).toBe("PAY-001");

    const lines = await db.shopifyPayoutLineItem.findMany({ where: { orgId: ORG_A } });
    expect(lines).toHaveLength(1);
    expect(lines[0].transactionType).toBe("charge");
  });

  it("inserts multiple line items for one payout ID", async () => {
    const summary = await importPayoutDetails(ORG_A, rowMap("PAY-001",
      makeDetailRow({ orderRef: "#1001", net: 57.5 }),
      makeDetailRow({ orderRef: "#1002", net: 28.0, transactionType: "refund" }),
    ), meta());
    expect(summary.inserted).toBe(1);
    const lines = await db.shopifyPayoutLineItem.findMany({ where: { orgId: ORG_A } });
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.transactionType).sort()).toEqual(["charge", "refund"]);
  });

  it("inserts multiple distinct payout IDs", async () => {
    const map = new Map([
      ["PAY-001", [makeDetailRow({ shopifyPayoutId: "PAY-001", payoutDate: "2026-05-01" })]],
      ["PAY-002", [makeDetailRow({ shopifyPayoutId: "PAY-002", payoutDate: "2026-05-02" })]],
    ]);
    const summary = await importPayoutDetails(ORG_A, map, meta());
    expect(summary.inserted).toBe(2);
    expect(summary.payoutIds).toContain("PAY-001");
    expect(summary.payoutIds).toContain("PAY-002");
  });
});

describeDb("importPayoutDetails — duplicates", () => {
  it("re-importing the same payout ID is a duplicate", async () => {
    await importPayoutDetails(ORG_A, rowMap("PAY-001", makeDetailRow()), meta());
    const second = await importPayoutDetails(ORG_A, rowMap("PAY-001", makeDetailRow()), meta());
    expect(second.inserted).toBe(0);
    expect(second.duplicate).toBe(1);

    const blobs = await db.shopifyPayoutDetailBlob.findMany({ where: { orgId: ORG_A } });
    expect(blobs).toHaveLength(1);
  });

  it("same payout ID across three calls stays as one blob", async () => {
    for (let i = 0; i < 3; i++) {
      await importPayoutDetails(ORG_A, rowMap("PAY-001", makeDetailRow()), meta());
    }
    const blobs = await db.shopifyPayoutDetailBlob.findMany({ where: { orgId: ORG_A } });
    expect(blobs).toHaveLength(1);
  });
});

describeDb("importPayoutDetails — payout matching", () => {
  it("links payout when net total matches within 0.001", async () => {
    const payoutDbId = await seedPayout(ORG_A, { payoutDate: "2026-05-01", totalCents: 97 });
    await importPayoutDetails(ORG_A, rowMap("PAY-001",
      makeDetailRow({ payoutDate: "2026-05-01", net: 97, shopifyPayoutId: "PAY-001" }),
    ), meta());
    const payout = await db.payout.findUnique({ where: { id: payoutDbId } });
    expect(payout!.shopifyPayoutId).toBe("PAY-001");
  });

  it("does not link when net total differs", async () => {
    await seedPayout(ORG_A, { payoutDate: "2026-05-01", totalCents: 97 });
    await importPayoutDetails(ORG_A, rowMap("PAY-001",
      makeDetailRow({ payoutDate: "2026-05-01", net: 50, shopifyPayoutId: "PAY-001" }),
    ), meta());
    const unlinked = await db.payout.findMany({ where: { shopifyPayoutId: null } });
    expect(unlinked).toHaveLength(1);
  });

  it("does not link when date does not match", async () => {
    await seedPayout(ORG_A, { payoutDate: "2026-05-01", totalCents: 97 });
    await importPayoutDetails(ORG_A, rowMap("PAY-001",
      makeDetailRow({ payoutDate: "2026-05-02", net: 97, shopifyPayoutId: "PAY-001" }),
    ), meta());
    const unlinked = await db.payout.findMany({ where: { shopifyPayoutId: null } });
    expect(unlinked).toHaveLength(1);
  });
});

describeDb("importPayoutDetails — order linking", () => {
  async function seedOrder(orgId: string, purchaseId: string): Promise<number> {
    const customer = await db.shopifyCustomer.create({ data: { orgId, email: `${purchaseId}@example.com` } });
    const order = await db.shopifyOrder.create({ data: { orgId, purchaseId, customerId: customer.id } });
    return order.id;
  }

  it("links a line item to its order by #-prefixed orderRef", async () => {
    const orderId = await seedOrder(ORG_A, "#1001");
    await importPayoutDetails(ORG_A, rowMap("PAY-001", makeDetailRow({ orderRef: "#1001" })), meta());

    const lines = await db.shopifyPayoutLineItem.findMany({ where: { orgId: ORG_A } });
    expect(lines).toHaveLength(1);
    expect(lines[0].shopifyOrderId).toBe(orderId);
  });

  it("leaves shopifyOrderId null when no order matches the orderRef", async () => {
    await seedOrder(ORG_A, "#1001");
    await importPayoutDetails(ORG_A, rowMap("PAY-001", makeDetailRow({ orderRef: "#9999" })), meta());

    const lines = await db.shopifyPayoutLineItem.findMany({ where: { orgId: ORG_A } });
    expect(lines[0].shopifyOrderId).toBeNull();
  });

  it("does not cross-link an order from another org", async () => {
    await seedOrder(ORG_B, "#1001");
    await importPayoutDetails(ORG_A, rowMap("PAY-001", makeDetailRow({ orderRef: "#1001" })), meta());

    const lines = await db.shopifyPayoutLineItem.findMany({ where: { orgId: ORG_A } });
    expect(lines[0].shopifyOrderId).toBeNull();
  });
});

describeDb("importPayoutDetails — org isolation", () => {
  it("same payout ID in different orgs both insert", async () => {
    await importPayoutDetails(ORG_A, rowMap("PAY-001", makeDetailRow()), meta());
    const summary = await importPayoutDetails(ORG_B, rowMap("PAY-001", makeDetailRow()), meta());
    expect(summary.inserted).toBe(1);
    expect(summary.duplicate).toBe(0);

    const blobsA = await db.shopifyPayoutDetailBlob.findMany({ where: { orgId: ORG_A } });
    const blobsB = await db.shopifyPayoutDetailBlob.findMany({ where: { orgId: ORG_B } });
    expect(blobsA).toHaveLength(1);
    expect(blobsB).toHaveLength(1);
  });
});

describeDb("importPayoutDetails — metadata", () => {
  it("records import file row with correct counts", async () => {
    const userId = newUserId();
    await importPayoutDetails(ORG_A, rowMap("PAY-001", makeDetailRow()), {
      userId,
      filename: "details.csv",
      buffer: Buffer.from("csv-content"),
    });
    const files = await db.payoutDetailImportFile.findMany({ where: { orgId: ORG_A } });
    expect(files).toHaveLength(1);
    expect(files[0].originalFilename).toBe("details.csv");
    expect(files[0].insertedCount).toBe(1);
    expect(files[0].duplicateCount).toBe(0);
    expect(files[0].fileHash).toMatch(/^[0-9a-f]{64}$/);
    expect(files[0].uploadedByUserId).toBe(userId);
  });

  it("handles empty row map without requiring DB insert", async () => {
    const summary = await importPayoutDetails(ORG_A, new Map(), {
      userId: newUserId(),
      filename: "empty.csv",
      buffer: Buffer.from(""),
    });
    expect(summary.inserted).toBe(0);
    expect(summary.duplicate).toBe(0);
    expect(summary.payoutIds).toEqual([]);
  });
});
