import { z } from "zod";

export const CompletedReceiptLineItemSchema = z.object({
  receiptLineItemId: z.number().int(),
  lineNumber: z.number().int(),
  description: z.string(),
  partNumber: z.string().nullable(),
  manufacturer: z.string().nullable(),
  // Positive but MAY be fractional — consumables are bought by weight/volume (e.g. 6.002 gal of
  // gasoline). Integer is still enforced where inventory is actually applied (ResolvedInventoryDelta
  // .quantityDelta × integer factor); non-inventory/fractional lines are filtered out before that.
  quantity: z.number().positive(),
  unitPriceCents: z.number().int(),
  totalPriceCents: z.number().int(),
  isDelayed: z.boolean(),
  gtin13: z.string().nullable().optional(),
  // Set when gtin13 is a provisional GTIN awaiting catalog resolution —
  // downstream apps should track it (e.g. for owner assignment / inventory)
  // and remap to the real GTIN once global-catalog resolves it.
  isProvisional: z.boolean().optional(),
  provisionalName: z.string().optional(),
});

export const CompletedReceiptSchema = z.object({
  receiptId: z.string(),
  orgId: z.string(),
  submitterId: z.number().int(),
  vendorName: z.string().nullable(),
  receiptNumber: z.string().nullable(),
  orderNumber: z.string().nullable(),
  currency: z.string().default("USD"),
  taxCents: z.number().int(),
  shippingCents: z.number().int(),
  discountCents: z.number().int(),
  receiptTotalCents: z.number().int(),
  receiptDate: z.string().nullable(),
  needsReimbursement: z.boolean(),
  reimbursementFor: z.string().nullable(),
  submittedAt: z.string().datetime(),
  // Historical QB-linked backfill: the receipt is already booked in QuickBooks. Downstream apps use
  // this to skip the live QB re-post (and auto-resolve owner re-signoff) while still building the
  // mapping/recognition + capital register. Defaults false for normal live receipts.
  backfill: z.boolean().optional().default(false),
  lineItems: z.array(CompletedReceiptLineItemSchema).min(1),
});

export type CompletedReceiptLineItem = z.infer<typeof CompletedReceiptLineItemSchema>;
export type CompletedReceipt = z.infer<typeof CompletedReceiptSchema>;
