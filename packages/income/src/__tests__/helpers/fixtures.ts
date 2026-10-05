import { db } from "../../db";
import type { ShopifyPayoutRow, ShopifyPayoutPayload } from "../../lib/schemas";
import type { ParsedOrder } from "../../lib/shopify-order-csv-parser";
import type { ShopifyOrderCsvRow } from "../../lib/shopify-order-schemas";

export const ORG_A = "00000000-0000-0000-0000-00000000000a";
export const ORG_B = "00000000-0000-0000-0000-00000000000b";

let _nextUserId = 500;
export function newUserId() { return _nextUserId++; }

// ── Cleanup ───────────────────────────────────────────────────────────────────
export async function clearAll() {
  await db.payoutReconciliation.deleteMany();
  await db.payoutConflict.deleteMany();
  await db.payout.deleteMany();
  await db.payoutImport.deleteMany();
  await db.payoutImportFile.deleteMany();
  await db.shopifyOrderLineItem.deleteMany();
  await db.shopifyPayoutLineItem.deleteMany();
  await db.shopifyOrder.deleteMany();
  await db.shopifyOrderBlob.deleteMany();
  await db.shopifyCustomer.deleteMany();
  await db.shopifyImportFile.deleteMany();
  await db.shopifyPayoutDetailBlob.deleteMany();
  await db.payoutDetailImportFile.deleteMany();
  await db.incomeAuditLog.deleteMany();
}

// ── Builders ──────────────────────────────────────────────────────────────────

export function makePayoutRow(overrides: Partial<ShopifyPayoutRow> = {}): ShopifyPayoutRow {
  return {
    payoutDate: "2026-05-01",
    status: "paid",
    chargesCents: 100,
    refundsCents: 0,
    adjustmentsCents: 0,
    marketplaceSalesTaxCents: 0,
    advancesCents: 0,
    reservedFundsCents: 0,
    feesCents: -3,
    retriedAmountCents: 0,
    totalCents: 97,
    currency: "USD",
    bankReference: "REF-1",
    ...overrides,
  };
}

export function makeOrderRow(overrides: Partial<ShopifyOrderCsvRow> = {}): ShopifyOrderCsvRow {
  return {
    name: "#1001",
    email: "buyer@example.com",
    financialStatus: "paid",
    paidAt: "2026-05-01 10:00:00",
    fulfillmentStatus: "fulfilled",
    fulfilledAt: "2026-05-02 10:00:00",
    currency: "USD",
    subtotal: 50,
    shipping: 5,
    taxes: 4,
    total: 59,
    discountCode: "",
    discountAmount: 0,
    createdAt: "2026-05-01 09:00:00",
    refundedAmount: 0,
    cancelledAt: "",
    shopifyNumericId: "99001",
    billingName: "Jane Buyer",
    billingStreet: "1 Main St",
    billingAddress1: "1 Main St",
    billingAddress2: "",
    billingCompany: "",
    billingCity: "Townsville",
    billingZip: "12345",
    billingProvince: "CA",
    billingCountry: "US",
    billingPhone: "555-0100",
    phone: "555-0100",
    lineitemQuantity: 1,
    lineitemName: "Widget",
    lineitemPrice: 50,
    lineitemCompareAtPrice: null,
    lineitemSku: "SKU-1",
    lineitemDiscount: 0,
    lineitemFulfillmentStatus: "fulfilled",
    ...overrides,
  };
}

export function makeParsedOrder(
  name: string,
  overrides: Partial<ShopifyOrderCsvRow> = {},
): ParsedOrder {
  const row = makeOrderRow({ name, ...overrides });
  return { orderRow: row, lineItems: [row] };
}

export function orderMap(...orders: Array<{ name: string; overrides?: Partial<ShopifyOrderCsvRow> }>): Map<string, ParsedOrder> {
  const m = new Map<string, ParsedOrder>();
  for (const o of orders) m.set(o.name, makeParsedOrder(o.name, o.overrides));
  return m;
}

// ── Direct seeders ────────────────────────────────────────────────────────────

export async function seedPayout(orgId: string, overrides: Partial<ShopifyPayoutRow> = {}): Promise<number> {
  const row = makePayoutRow(overrides);
  const payload: ShopifyPayoutPayload = { ...row, source: "shopify" };
  const importRow = await db.payoutImport.create({
    data: {
      orgId,
      payoutDate: row.payoutDate,
      totalCents: row.totalCents,
      payload: JSON.stringify(payload),
    },
  });
  await db.payout.create({
    data: {
      id: importRow.id,
      orgId,
      payoutDate: row.payoutDate,
      status: row.status,
      chargesCents: row.chargesCents,
      refundsCents: row.refundsCents,
      adjustmentsCents: row.adjustmentsCents,
      marketplaceSalesTaxCents: row.marketplaceSalesTaxCents,
      advancesCents: row.advancesCents,
      reservedFundsCents: row.reservedFundsCents,
      feesCents: row.feesCents,
      retriedAmountCents: row.retriedAmountCents,
      totalCents: row.totalCents,
      currency: row.currency,
      bankReference: row.bankReference,
    },
  });
  return importRow.id;
}

export async function seedConflict(orgId: string, existingImportId: number, overrides: Partial<ShopifyPayoutRow> = {}): Promise<number> {
  const row = makePayoutRow({ bankReference: "REF-CONFLICT", ...overrides });
  const payload: ShopifyPayoutPayload = { ...row, source: "shopify" };
  const conflict = await db.payoutConflict.create({
    data: {
      orgId,
      incomingPayload: JSON.stringify(payload),
      existingImportId,
      reason: "payload_mismatch",
      status: "pending",
    },
  });
  return conflict.id;
}
