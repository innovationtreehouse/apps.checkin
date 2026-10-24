/**
 * Zod schemas for the Shopify Admin GraphQL node shapes we ingest, plus
 * normalizers that turn a raw node into the flat, cents-based shape the loader
 * upserts. Both the live API sync and the `inject` path run through these, so a
 * hand-authored fixture is validated and projected exactly like real API data.
 *
 * NOTE: exact GraphQL field names (esp. associatedOrder / sourceOrderTransactionId
 * and payout summary sub-fields) must be confirmed against the pinned API version
 * during implementation. Schemas are deliberately lenient (passthrough + optional)
 * so a minor field rename does not throw away an entire batch.
 */
import { z } from "zod";
import { ObjectType } from "../generated/prisma/client.js";
import { toCents } from "../money.js";
import { parseDate, legacyIdFromGid } from "../dates.js";

// --- shared money shape: { shopMoney: { amount, currencyCode } } -------------
const moneyV2 = z
  .object({ amount: z.union([z.string(), z.number()]).nullish(), currencyCode: z.string().nullish() })
  .passthrough();
const moneyBag = z.object({ shopMoney: moneyV2.nullish() }).passthrough();

function bagCents(bag: z.infer<typeof moneyBag> | null | undefined): number {
  return toCents(bag?.shopMoney?.amount ?? 0);
}
function bagCurrency(bag: z.infer<typeof moneyBag> | null | undefined): string | undefined {
  return bag?.shopMoney?.currencyCode ?? undefined;
}

/** A GraphQL connection may arrive as `{ nodes: [...] }` or `{ edges: [{ node }] }`. */
function connectionNodes<T>(
  conn: { nodes?: T[] | null; edges?: { node: T }[] | null } | null | undefined,
): T[] {
  if (!conn) return [];
  if (Array.isArray(conn.nodes)) return conn.nodes;
  if (Array.isArray(conn.edges)) return conn.edges.map((e) => e.node);
  return [];
}

// --- ORDER -------------------------------------------------------------------
const orderLineSchema = z
  .object({
    id: z.string(),
    sku: z.string().nullish(),
    title: z.string().nullish(),
    name: z.string().nullish(),
    quantity: z.number().nullish(),
    // Excludes units an order edit removed or a refund took back; `quantity` keeps them.
    currentQuantity: z.number().nullish(),
    // Null for custom/deleted-product lines — Shopify's LineItem.variant is nullable.
    // legacyResourceId may arrive as number or string depending on the API surface.
    variant: z
      .object({ id: z.string().nullish(), legacyResourceId: z.union([z.string(), z.number()]).nullish() })
      .passthrough()
      .nullish(),
    originalUnitPriceSet: moneyBag.nullish(),
    discountedTotalSet: moneyBag.nullish(),
    totalDiscountSet: moneyBag.nullish(),
  })
  .passthrough();

const refundSchema = z
  .object({
    id: z.string(),
    createdAt: z.string().nullish(),
    totalRefundedSet: moneyBag.nullish(),
    note: z.string().nullish(),
  })
  .passthrough();

/** A refund ingested on its own (not embedded in an order) must name its order. */
export const refundSchemaWithOrder = refundSchema.extend({ orderGid: z.string() });

export function normalizeStandaloneRefund(node: z.infer<typeof refundSchemaWithOrder>): NormalizedRefund {
  return {
    refundGid: node.id,
    orderGid: node.orderGid,
    createdAt: parseDate(node.createdAt),
    totalRefundedCents: bagCents(node.totalRefundedSet),
    note: node.note ?? undefined,
  };
}

export const orderNodeSchema = z
  .object({
    id: z.string(),
    legacyResourceId: z.union([z.string(), z.number()]).nullish(),
    name: z.string().nullish(),
    email: z.string().nullish(),
    customer: z.object({ email: z.string().nullish(), displayName: z.string().nullish() }).passthrough().nullish(),
    createdAt: z.string().nullish(),
    processedAt: z.string().nullish(),
    updatedAt: z.string().nullish(),
    cancelledAt: z.string().nullish(),
    test: z.boolean().nullish(),
    displayFinancialStatus: z.string().nullish(),
    displayFulfillmentStatus: z.string().nullish(),
    // Cart attributes (Membership_Process_ID / CheckMeIn_Account_ID + Program_ID) carried on the order.
    customAttributes: z.array(z.object({ key: z.string(), value: z.string().nullish() }).passthrough()).nullish(),
    // The coupon codes applied at checkout, verbatim. What lets checkin tell a
    // board-created discount (volunteer rate, time-boxed promo) from a shortfall.
    discountCodes: z.array(z.string()).nullish(),
    currentSubtotalPriceSet: moneyBag.nullish(),
    totalShippingPriceSet: moneyBag.nullish(),
    currentTotalTaxSet: moneyBag.nullish(),
    totalDiscountsSet: moneyBag.nullish(),
    currentTotalPriceSet: moneyBag.nullish(),
    totalRefundedSet: moneyBag.nullish(),
    lineItems: z.object({ nodes: z.array(orderLineSchema).nullish(), edges: z.array(z.object({ node: orderLineSchema })).nullish() }).passthrough().nullish(),
    refunds: z.array(refundSchema).nullish(),
  })
  .passthrough();

export type OrderNode = z.infer<typeof orderNodeSchema>;

export interface NormalizedOrderLine {
  lineGid: string;
  sku?: string;
  title?: string;
  quantity: number;
  /** Units still on the order after edits and refunds. Absent when the payload predates the field. */
  currentQuantity?: number;
  /** Shopify ProductVariant GID (gid://shopify/ProductVariant/N). Absent for custom/deleted-product lines. */
  variantGid?: string;
  /** Numeric variant id — what checkin stores in BoardSettings/Program shopify*VariantId, so this is the reconciliation join key. */
  variantLegacyId?: string;
  priceCents: number;
  discountCents: number;
}
export interface NormalizedRefund {
  refundGid: string;
  orderGid: string;
  createdAt: Date | null;
  totalRefundedCents: number;
  note?: string;
}
export interface NormalizedOrder {
  shopifyGid: string;
  legacyId?: string;
  name?: string;
  customerEmail?: string;
  customerName?: string;
  financialStatus?: string;
  fulfillmentStatus?: string;
  createdAt: Date | null;
  processedAt: Date | null;
  updatedAt: Date | null;
  cancelledAt: Date | null;
  currency?: string;
  subtotalCents: number;
  shippingCents: number;
  taxCents: number;
  discountCents: number;
  totalCents: number;
  totalRefundedCents: number;
  test: boolean;
  /** Raw order cart attributes ([{key, value}]), stored as JSON. undefined when absent. */
  noteAttributes?: { key: string; value: string | null }[];
  /** Coupon codes applied at checkout, verbatim. Empty for undiscounted orders. */
  discountCodes: string[];
  lines: NormalizedOrderLine[];
  refunds: NormalizedRefund[];
}

export function normalizeOrder(node: OrderNode): NormalizedOrder {
  const lines = connectionNodes(node.lineItems).map((l) => ({
    lineGid: l.id,
    sku: l.sku ?? undefined,
    title: l.title ?? l.name ?? undefined,
    quantity: l.quantity ?? 1,
    currentQuantity: l.currentQuantity ?? undefined,
    variantGid: l.variant?.id ?? undefined,
    variantLegacyId:
      l.variant?.legacyResourceId != null
        ? String(l.variant.legacyResourceId)
        : l.variant?.id
          ? legacyIdFromGid(l.variant.id)
          : undefined,
    priceCents: bagCents(l.originalUnitPriceSet),
    discountCents: bagCents(l.totalDiscountSet),
  }));
  const refunds = (node.refunds ?? []).map((r) => ({
    refundGid: r.id,
    orderGid: node.id,
    createdAt: parseDate(r.createdAt),
    totalRefundedCents: bagCents(r.totalRefundedSet),
    note: r.note ?? undefined,
  }));
  return {
    shopifyGid: node.id,
    legacyId: node.legacyResourceId != null ? String(node.legacyResourceId) : legacyIdFromGid(node.id),
    name: node.name ?? undefined,
    customerEmail: node.customer?.email ?? node.email ?? undefined,
    customerName: node.customer?.displayName ?? undefined,
    financialStatus: node.displayFinancialStatus ?? undefined,
    fulfillmentStatus: node.displayFulfillmentStatus ?? undefined,
    createdAt: parseDate(node.createdAt),
    processedAt: parseDate(node.processedAt),
    updatedAt: parseDate(node.updatedAt),
    cancelledAt: parseDate(node.cancelledAt),
    currency: bagCurrency(node.currentTotalPriceSet),
    subtotalCents: bagCents(node.currentSubtotalPriceSet),
    shippingCents: bagCents(node.totalShippingPriceSet),
    taxCents: bagCents(node.currentTotalTaxSet),
    discountCents: bagCents(node.totalDiscountsSet),
    totalCents: bagCents(node.currentTotalPriceSet),
    totalRefundedCents: bagCents(node.totalRefundedSet),
    test: node.test ?? false,
    noteAttributes: node.customAttributes
      ? node.customAttributes.map((a) => ({ key: a.key, value: a.value ?? null }))
      : undefined,
    discountCodes: node.discountCodes ?? [],
    lines,
    refunds,
  };
}

// --- PAYOUT ------------------------------------------------------------------
const payoutSummarySchema = z
  .object({
    chargesGross: moneyV2.nullish(),
    chargesFee: moneyV2.nullish(),
    // sic: Shopify's name for GROSS refunds on the payout summary (no `refundsGross` exists)
    refundsFeeGross: moneyV2.nullish(),
    refundsFee: moneyV2.nullish(),
    adjustmentsGross: moneyV2.nullish(),
    adjustmentsFee: moneyV2.nullish(),
    reservedFundsGross: moneyV2.nullish(),
    retriedPayoutsGross: moneyV2.nullish(),
  })
  .passthrough();

export const payoutNodeSchema = z
  .object({
    id: z.string(),
    legacyResourceId: z.union([z.string(), z.number()]).nullish(),
    issuedAt: z.string().nullish(),
    status: z.string().nullish(),
    net: moneyV2.nullish(),
    summary: payoutSummarySchema.nullish(),
  })
  .passthrough();

export type PayoutNode = z.infer<typeof payoutNodeSchema>;

export interface NormalizedPayout {
  payoutGid: string;
  legacyId?: string;
  issuedAt: Date | null;
  status?: string;
  currency?: string;
  netCents: number;
  chargesGrossCents: number;
  chargesFeeCents: number;
  refundsGrossCents: number;
  refundsFeeCents: number;
  adjustmentsGrossCents: number;
  adjustmentsFeeCents: number;
  reservedFundsCents: number;
  retriedCents: number;
}

const v2Cents = (m: z.infer<typeof moneyV2> | null | undefined) => toCents(m?.amount ?? 0);

export function normalizePayout(node: PayoutNode): NormalizedPayout {
  const s = node.summary ?? {};
  return {
    payoutGid: node.id,
    legacyId: node.legacyResourceId != null ? String(node.legacyResourceId) : legacyIdFromGid(node.id),
    issuedAt: parseDate(node.issuedAt),
    status: node.status ?? undefined,
    currency: node.net?.currencyCode ?? undefined,
    netCents: v2Cents(node.net),
    chargesGrossCents: v2Cents(s.chargesGross),
    chargesFeeCents: v2Cents(s.chargesFee),
    refundsGrossCents: v2Cents(s.refundsFeeGross),
    refundsFeeCents: v2Cents(s.refundsFee),
    adjustmentsGrossCents: v2Cents(s.adjustmentsGross),
    adjustmentsFeeCents: v2Cents(s.adjustmentsFee),
    reservedFundsCents: v2Cents(s.reservedFundsGross),
    retriedCents: v2Cents(s.retriedPayoutsGross),
  };
}

// --- BALANCE TRANSACTION (the payout <-> order bridge) -----------------------
export const balanceTxnNodeSchema = z
  .object({
    id: z.string(),
    type: z.string().nullish(),
    amount: moneyV2.nullish(),
    fee: moneyV2.nullish(),
    net: moneyV2.nullish(),
    transactionDate: z.string().nullish(),
    sourceOrderTransactionId: z.string().nullish(),
    sourceId: z.union([z.string(), z.number()]).nullish(),
    associatedPayout: z.object({ id: z.string().nullish() }).passthrough().nullish(),
    associatedOrder: z.object({ id: z.string().nullish(), name: z.string().nullish() }).passthrough().nullish(),
  })
  .passthrough();

export type BalanceTxnNode = z.infer<typeof balanceTxnNodeSchema>;

export interface NormalizedBalanceTxn {
  txnGid: string;
  payoutGid?: string;
  orderGid?: string;
  type: string;
  amountCents: number;
  feeCents: number;
  netCents: number;
  currency?: string;
  transactionDate: Date | null;
  sourceOrderTransactionId?: string;
}

export function normalizeBalanceTxn(node: BalanceTxnNode): NormalizedBalanceTxn {
  return {
    txnGid: node.id,
    payoutGid: node.associatedPayout?.id ?? undefined,
    orderGid: node.associatedOrder?.id ?? undefined,
    type: node.type ?? "UNKNOWN",
    amountCents: v2Cents(node.amount), // signed: refunds/adjustments are negative
    feeCents: v2Cents(node.fee),
    netCents: v2Cents(node.net),
    currency: node.amount?.currencyCode ?? node.net?.currencyCode ?? undefined,
    transactionDate: parseDate(node.transactionDate),
    sourceOrderTransactionId: node.sourceOrderTransactionId ?? undefined,
  };
}

// --- raw-event metadata extraction (shared by sync + inject) ------------------
export interface RawEventMeta {
  objectType: ObjectType;
  shopifyGid: string;
  shopifyLegacyId?: string;
  occurredAt: Date | null;
}

/** Validate an unknown node for the given object type and pull out log metadata. */
export function rawMetaForNode(objectType: ObjectType, node: unknown): RawEventMeta {
  switch (objectType) {
    case ObjectType.ORDER: {
      const o = normalizeOrder(orderNodeSchema.parse(node));
      return { objectType, shopifyGid: o.shopifyGid, shopifyLegacyId: o.legacyId, occurredAt: o.updatedAt ?? o.createdAt };
    }
    case ObjectType.PAYOUT: {
      const p = normalizePayout(payoutNodeSchema.parse(node));
      return { objectType, shopifyGid: p.payoutGid, shopifyLegacyId: p.legacyId, occurredAt: p.issuedAt };
    }
    case ObjectType.BALANCE_TXN: {
      const b = normalizeBalanceTxn(balanceTxnNodeSchema.parse(node));
      return { objectType, shopifyGid: b.txnGid, occurredAt: b.transactionDate };
    }
    case ObjectType.REFUND: {
      const r = refundSchemaWithOrder.parse(node);
      return { objectType, shopifyGid: r.id, occurredAt: parseDate(r.createdAt) };
    }
    default:
      throw new Error(`Unsupported object type: ${objectType}`);
  }
}
