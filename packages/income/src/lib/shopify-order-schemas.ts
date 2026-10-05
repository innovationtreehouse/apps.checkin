import { z } from "zod";

export const ShopifyOrderCsvRowSchema = z.object({
  // Order identity
  name: z.string(),         // "#1177" — purchase ID
  email: z.string(),
  financialStatus: z.string(),
  paidAt: z.string(),
  fulfillmentStatus: z.string(),
  fulfilledAt: z.string(),
  currency: z.string(),
  subtotal: z.number(),
  shipping: z.number(),
  taxes: z.number(),
  total: z.number(),
  discountCode: z.string(),
  discountAmount: z.number(),
  createdAt: z.string(),
  refundedAmount: z.number(),
  cancelledAt: z.string(),
  shopifyNumericId: z.string(), // "Id" column numeric string
  // Billing
  billingName: z.string(),
  billingStreet: z.string(),
  billingAddress1: z.string(),
  billingAddress2: z.string(),
  billingCompany: z.string(),
  billingCity: z.string(),
  billingZip: z.string(),
  billingProvince: z.string(),
  billingCountry: z.string(),
  billingPhone: z.string(),
  phone: z.string(),
  // Line item fields
  lineitemQuantity: z.number(),
  lineitemName: z.string(),
  lineitemPrice: z.number(),
  lineitemCompareAtPrice: z.number().nullable(),
  lineitemSku: z.string(),
  lineitemDiscount: z.number(),
  lineitemFulfillmentStatus: z.string(),
});

export type ShopifyOrderCsvRow = z.infer<typeof ShopifyOrderCsvRowSchema>;

export const ShopifyOrderBlobPayloadSchema = z.object({
  source: z.literal("Shopify"),
  order: z.object({
    name: z.string(),
    email: z.string(),
    financialStatus: z.string(),
    paidAt: z.string(),
    fulfillmentStatus: z.string(),
    fulfilledAt: z.string(),
    currency: z.string(),
    subtotal: z.number(),
    shipping: z.number(),
    taxes: z.number(),
    total: z.number(),
    discountCode: z.string(),
    discountAmount: z.number(),
    createdAt: z.string(),
    refundedAmount: z.number(),
    cancelledAt: z.string(),
    shopifyNumericId: z.string(),
    billingName: z.string(),
    billingStreet: z.string(),
    billingAddress1: z.string(),
    billingAddress2: z.string(),
    billingCompany: z.string(),
    billingCity: z.string(),
    billingZip: z.string(),
    billingProvince: z.string(),
    billingCountry: z.string(),
    billingPhone: z.string(),
    phone: z.string(),
    email2: z.string().optional(),
  }),
  lineItems: z.array(z.object({
    quantity: z.number(),
    name: z.string(),
    price: z.number(),
    compareAtPrice: z.number().nullable(),
    sku: z.string(),
    discount: z.number(),
    fulfillmentStatus: z.string(),
  })),
});

export type ShopifyOrderBlobPayload = z.infer<typeof ShopifyOrderBlobPayloadSchema>;
