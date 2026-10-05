import { z } from "zod";

export const ShopifyPayoutDetailRowSchema = z.object({
  transactionDate: z.string(),
  transactionType: z.enum(["charge", "refund"]),
  orderRef: z.string().nullable(),
  payoutStatus: z.string(),
  payoutDate: z.string(),
  shopifyPayoutId: z.string(),
  amount: z.number(),
  fee: z.number(),
  net: z.number(),
  currency: z.string(),
});

export const ShopifyPayoutDetailPayloadSchema = z.object({
  source: z.literal("shopify_payment_transactions"),
  lines: z.array(ShopifyPayoutDetailRowSchema),
});

export type ShopifyPayoutDetailRow = z.infer<typeof ShopifyPayoutDetailRowSchema>;
export type ShopifyPayoutDetailPayload = z.infer<typeof ShopifyPayoutDetailPayloadSchema>;
