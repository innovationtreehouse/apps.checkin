import { describe, it, expect } from "vitest";
import { parseShopifyOrderCsv } from "../../lib/shopify-order-csv-parser";

const HDR = [
  "Name", "Email", "Financial Status", "Paid at", "Fulfillment Status", "Fulfilled at",
  "Currency", "Subtotal", "Shipping", "Taxes", "Total", "Discount Code", "Discount Amount",
  "Created at", "Refunded Amount", "Cancelled at", "Id",
  "Billing Name", "Billing Street", "Billing Address1", "Billing Address2", "Billing Company",
  "Billing City", "Billing Zip", "Billing Province", "Billing Country", "Billing Phone", "Phone",
  "Lineitem quantity", "Lineitem name", "Lineitem price", "Lineitem compare at price",
  "Lineitem sku", "Lineitem discount", "Lineitem fulfillment status",
].join(",");

const DATA_ROW = [
  "#1001", "buyer@example.com", "paid", "2026-05-01 10:00:00", "fulfilled", "2026-05-02 10:00:00",
  "USD", "50", "5", "4", "59", "", "0", "2026-05-01 09:00:00", "0", "", "99001",
  "Jane Buyer", "1 Main St", "1 Main St", "", "", "Townsville", "12345", "CA", "US", "555-0100", "555-0100",
  "1", "Widget", "50", "", "SKU-1", "0", "fulfilled",
].join(",");

function csv(...rows: string[]): Buffer {
  return Buffer.from([HDR, ...rows].join("\n"));
}

describe("parseShopifyOrderCsv — happy paths", () => {
  it("parses a single order with one line item", () => {
    const result = parseShopifyOrderCsv(csv(DATA_ROW));
    expect(result.size).toBe(1);
    const order = result.get("#1001")!;
    expect(order).toBeDefined();
    expect(order.orderRow.name).toBe("#1001");
    expect(order.orderRow.email).toBe("buyer@example.com");
    expect(order.orderRow.financialStatus).toBe("paid");
    expect(order.orderRow.total).toBe(5900);
    expect(order.lineItems).toHaveLength(1);
  });

  it("groups multiple rows with same name as one order with multiple line items", () => {
    const row2 = DATA_ROW
      .replace("1,Widget,50,,SKU-1,0", "2,Gadget,25,,SKU-2,0");
    const result = parseShopifyOrderCsv(csv(DATA_ROW, row2));
    expect(result.size).toBe(1);
    const order = result.get("#1001")!;
    expect(order.lineItems).toHaveLength(2);
    expect(order.lineItems[0].lineitemName).toBe("Widget");
    expect(order.lineItems[1].lineitemName).toBe("Gadget");
  });

  it("parses two distinct orders", () => {
    const row2 = DATA_ROW.replace("#1001,", "#1002,").replace(",99001,", ",99002,");
    const result = parseShopifyOrderCsv(csv(DATA_ROW, row2));
    expect(result.size).toBe(2);
    expect(result.has("#1001")).toBe(true);
    expect(result.has("#1002")).toBe(true);
  });

  it("returns empty map for header-only CSV", () => {
    expect(parseShopifyOrderCsv(csv()).size).toBe(0);
  });

  it("handles BOM prefix", () => {
    const bom = "﻿" + HDR + "\n" + DATA_ROW;
    const result = parseShopifyOrderCsv(Buffer.from(bom));
    expect(result.size).toBe(1);
    expect(result.get("#1001")).toBeDefined();
  });
});

describe("parseShopifyOrderCsv — edge cases", () => {
  it("skips rows with missing Name", () => {
    const noName = DATA_ROW.replace("#1001,", ",");
    const result = parseShopifyOrderCsv(csv(noName));
    expect(result.size).toBe(0);
  });

  it("blank numeric fields default to 0", () => {
    // Build row with blank numeric columns (same column count, commas preserved)
    const noNumerics = DATA_ROW.replace(",50,5,4,59,,0,", ",,,,,,,");
    const result = parseShopifyOrderCsv(csv(noNumerics));
    const order = result.get("#1001")!;
    expect(order.orderRow.subtotal).toBe(0);
    expect(order.orderRow.shipping).toBe(0);
  });

  it("lineitemCompareAtPrice is null when blank", () => {
    const result = parseShopifyOrderCsv(csv(DATA_ROW));
    expect(result.get("#1001")!.orderRow.lineitemCompareAtPrice).toBeNull();
  });

  it("lineitemCompareAtPrice parses when present", () => {
    const withPrice = DATA_ROW.replace(",Widget,50,,SKU-1", ",Widget,50,60.00,SKU-1");
    const result = parseShopifyOrderCsv(csv(withPrice));
    expect(result.get("#1001")!.orderRow.lineitemCompareAtPrice).toBe(6000);
  });

  it("non-numeric lineitem price defaults to 0", () => {
    const badPrice = DATA_ROW.replace(",Widget,50,,SKU-1", ",Widget,N/A,,SKU-1");
    const result = parseShopifyOrderCsv(csv(badPrice));
    expect(result.get("#1001")!.orderRow.lineitemPrice).toBe(0);
  });
});
