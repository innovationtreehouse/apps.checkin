import { parse } from "csv-parse/sync";
import { ShopifyOrderCsvRowSchema, type ShopifyOrderCsvRow } from "./shopify-order-schemas";
import { toCents, toCentsNullable } from "./money";

// Non-money counts (e.g. quantity) stay as plain integers; money uses toCents.
function parseCount(val: string | undefined): number {
  if (!val || val.trim() === "") return 0;
  const n = parseFloat(val);
  return isNaN(n) ? 0 : n;
}

export interface ParsedOrder {
  orderRow: ShopifyOrderCsvRow;
  lineItems: ShopifyOrderCsvRow[];
}

export function parseShopifyOrderCsv(buffer: Buffer): Map<string, ParsedOrder> {
  const records = parse(buffer, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  }) as Record<string, string>[];

  const orderMap = new Map<string, ParsedOrder>();

  for (const r of records) {
    const purchaseId = r["Name"] ?? "";
    if (!purchaseId) continue;

    const lineItemRow = ShopifyOrderCsvRowSchema.parse({
      name: r["Name"] ?? "",
      email: r["Email"] ?? "",
      financialStatus: r["Financial Status"] ?? "",
      paidAt: r["Paid at"] ?? "",
      fulfillmentStatus: r["Fulfillment Status"] ?? "",
      fulfilledAt: r["Fulfilled at"] ?? "",
      currency: r["Currency"] ?? "USD",
      subtotal: toCents(r["Subtotal"]),
      shipping: toCents(r["Shipping"]),
      taxes: toCents(r["Taxes"]),
      total: toCents(r["Total"]),
      discountCode: r["Discount Code"] ?? "",
      discountAmount: toCents(r["Discount Amount"]),
      createdAt: r["Created at"] ?? "",
      refundedAmount: toCents(r["Refunded Amount"]),
      cancelledAt: r["Cancelled at"] ?? "",
      shopifyNumericId: r["Id"] ?? "",
      billingName: r["Billing Name"] ?? "",
      billingStreet: r["Billing Street"] ?? "",
      billingAddress1: r["Billing Address1"] ?? "",
      billingAddress2: r["Billing Address2"] ?? "",
      billingCompany: r["Billing Company"] ?? "",
      billingCity: r["Billing City"] ?? "",
      billingZip: r["Billing Zip"] ?? "",
      billingProvince: r["Billing Province"] ?? "",
      billingCountry: r["Billing Country"] ?? "",
      billingPhone: r["Billing Phone"] ?? "",
      phone: r["Phone"] ?? "",
      lineitemQuantity: parseCount(r["Lineitem quantity"]),
      lineitemName: r["Lineitem name"] ?? "",
      lineitemPrice: toCents(r["Lineitem price"]),
      lineitemCompareAtPrice: toCentsNullable(r["Lineitem compare at price"]),
      lineitemSku: r["Lineitem sku"] ?? "",
      lineitemDiscount: toCents(r["Lineitem discount"]),
      lineitemFulfillmentStatus: r["Lineitem fulfillment status"] ?? "",
    });

    if (!orderMap.has(purchaseId)) {
      orderMap.set(purchaseId, { orderRow: lineItemRow, lineItems: [lineItemRow] });
    } else {
      orderMap.get(purchaseId)!.lineItems.push(lineItemRow);
    }
  }

  return orderMap;
}
