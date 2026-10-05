import { z } from "zod";

export const ShopifyPayoutRowSchema = z.object({
  payoutDate: z.string(),
  status: z.string(),
  chargesCents: z.number(),
  refundsCents: z.number(),
  adjustmentsCents: z.number(),
  marketplaceSalesTaxCents: z.number(),
  advancesCents: z.number(),
  reservedFundsCents: z.number(),
  feesCents: z.number(),
  retriedAmountCents: z.number(),
  totalCents: z.number(),
  currency: z.string(),
  bankReference: z.string().nullable(),
});

export const ShopifyPayoutPayloadSchema = ShopifyPayoutRowSchema.extend({
  source: z.literal("shopify"),
});

export type ShopifyPayoutRow = z.infer<typeof ShopifyPayoutRowSchema>;
export type ShopifyPayoutPayload = z.infer<typeof ShopifyPayoutPayloadSchema>;
