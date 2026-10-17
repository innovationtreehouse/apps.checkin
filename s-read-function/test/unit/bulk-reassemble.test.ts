import { describe, it, expect } from "vitest";
import { reassembleOrders } from "../../src/shopify/bulk.js";
import { normalizeOrder, orderNodeSchema } from "@checkin/s-ingest-core";

describe("reassembleOrders (bulk JSONL parent/child)", () => {
  // Flat JSONL records as Shopify emits them: parent order, then children with __parentId.
  const records = [
    {
      id: "gid://shopify/Order/1001",
      name: "#1001",
      displayFinancialStatus: "PAID",
      currentTotalPriceSet: { shopMoney: { amount: "100.00", currencyCode: "USD" } },
    },
    {
      id: "gid://shopify/LineItem/2001",
      __parentId: "gid://shopify/Order/1001",
      sku: "WIDGET-1",
      title: "Widget",
      quantity: 2,
      originalUnitPriceSet: { shopMoney: { amount: "50.00", currencyCode: "USD" } },
    },
    {
      id: "gid://shopify/Refund/3001",
      __parentId: "gid://shopify/Order/1001",
      createdAt: "2026-02-03T12:00:00Z",
      totalRefundedSet: { shopMoney: { amount: "20.00", currencyCode: "USD" } },
    },
  ];

  it("nests line items and refunds under their parent order (children as separate lines)", () => {
    const orders = reassembleOrders(records);
    expect(orders).toHaveLength(1);
    const n = normalizeOrder(orderNodeSchema.parse(orders[0]));
    expect(n.legacyId).toBe("1001"); // derived from gid when absent in bulk output
    expect(n.lines).toHaveLength(1);
    expect(n.lines[0].priceCents).toBe(5000);
    expect(n.refunds).toHaveLength(1);
    expect(n.refunds[0].totalRefundedCents).toBe(2000);
  });

  // Shopify Bulk returns non-connection LIST fields (order.refunds) INLINE on the order line,
  // not as separate `__parentId` lines. Reassembly must keep them (this is the F3 regression).
  it("preserves refunds returned INLINE on the order record", () => {
    const inline = [
      {
        id: "gid://shopify/Order/1002",
        name: "#1002",
        currentTotalPriceSet: { shopMoney: { amount: "80.00", currencyCode: "USD" } },
        refunds: [
          { id: "gid://shopify/Refund/4001", createdAt: "2026-03-01T00:00:00Z", totalRefundedSet: { shopMoney: { amount: "15.00", currencyCode: "USD" } } },
        ],
      },
      {
        id: "gid://shopify/LineItem/5001",
        __parentId: "gid://shopify/Order/1002",
        sku: "GADGET-1",
        quantity: 1,
        originalUnitPriceSet: { shopMoney: { amount: "80.00", currencyCode: "USD" } },
      },
    ];
    const n = normalizeOrder(orderNodeSchema.parse(reassembleOrders(inline)[0]));
    expect(n.lines).toHaveLength(1);
    expect(n.refunds).toHaveLength(1);
    expect(n.refunds[0].totalRefundedCents).toBe(1500);
  });

  // If a child ever appears BOTH inline and as a __parentId line, it must not be double-counted.
  it("de-dupes a child present both inline and as a separate line", () => {
    const both = [
      {
        id: "gid://shopify/Order/1003",
        name: "#1003",
        currentTotalPriceSet: { shopMoney: { amount: "10.00", currencyCode: "USD" } },
        refunds: [
          { id: "gid://shopify/Refund/6001", totalRefundedSet: { shopMoney: { amount: "5.00", currencyCode: "USD" } } },
        ],
      },
      {
        id: "gid://shopify/Refund/6001",
        __parentId: "gid://shopify/Order/1003",
        totalRefundedSet: { shopMoney: { amount: "5.00", currencyCode: "USD" } },
      },
    ];
    const n = normalizeOrder(orderNodeSchema.parse(reassembleOrders(both)[0]));
    expect(n.refunds).toHaveLength(1);
  });
});
