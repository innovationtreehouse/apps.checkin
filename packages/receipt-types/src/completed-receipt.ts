import { z } from "zod";

// Bounds per-unit work downstream (one capital asset is minted per unit) while
// clearing any real bulk purchase.
export const MAX_LINE_QUANTITY = 100_000;

const cents = z.number().int().nonnegative();

export const CompletedReceiptLineItemSchema = z.object({
  receiptLineItemId: z.number().int(),
  lineNumber: z.number().int(),
  description: z.string(),
  partNumber: z.string().nullable(),
  manufacturer: z.string().nullable(),
  // Positive but MAY be fractional — consumables are bought by weight/volume (e.g. 6.002 gal of
  // gasoline). Integer is still enforced where inventory is actually applied (ResolvedInventoryDelta
  // .quantityDelta × integer factor); non-inventory/fractional lines are filtered out before that.
  quantity: z.number().positive().max(MAX_LINE_QUANTITY),
  unitPriceCents: cents,
  totalPriceCents: cents,
  isDelayed: z.boolean(),
  gtin13: z.string().nullable().optional(),
  // Set when gtin13 is a provisional GTIN awaiting catalog resolution —
  // downstream apps should track it (e.g. for owner assignment / inventory)
  // and remap to the real GTIN once global-catalog resolves it.
  isProvisional: z.boolean().optional(),
  provisionalName: z.string().optional(),
  // Receiving marked the line non-inventory (e.g. a pizza order): it has no catalog item, so
  // finance picks its owner and QuickBooks account by hand on every expense.
  nonInventory: z.boolean().optional(),
});

/** Why a receipt waited on finance review. */
export const FINANCIAL_REVIEW_REASONS = ["tax", "old_date", "future_date", "submitter_correction"] as const;
export type FinancialReviewReason = (typeof FINANCIAL_REVIEW_REASONS)[number];

// Finance's approval of a receipt that waited on finance review.
export const CompletedReceiptFinanceReviewSchema = z.object({
  outcome: z.literal("approved"),
  reasons: z.array(z.enum(FINANCIAL_REVIEW_REASONS)),
  // The approving checkin Person.id.
  decidedByPersonId: z.number().int().positive(),
  note: z.string().nullable().optional(),
  // The receipt's tax when finance approved it; the approval covers that amount only.
  taxCents: cents.optional(),
  decidedAt: z.string().datetime(),
});

export const CompletedReceiptSchema = z.object({
  receiptId: z.string(),
  orgId: z.string(),
  submitterId: z.number().int(),
  vendorName: z.string().nullable(),
  receiptNumber: z.string().nullable(),
  orderNumber: z.string().nullable(),
  currency: z.string().default("USD"),
  taxCents: cents,
  shippingCents: cents,
  discountCents: cents,
  receiptTotalCents: cents,
  receiptDate: z.string().nullable(),
  needsReimbursement: z.boolean(),
  // Display only; the reimbursee's identity is reimburseePersonId.
  reimbursementFor: z.string().nullable(),
  // The checkin Person.id owed the reimbursement, never free text.
  reimburseePersonId: z.number().int().positive().optional(),
  submittedAt: z.string().datetime(),
  // Historical QB-linked backfill: the receipt is already booked in QuickBooks. Downstream apps use
  // this to skip the live QB re-post (and auto-resolve owner re-signoff) while still building the
  // mapping/recognition + capital register. Defaults false for normal live receipts.
  backfill: z.boolean().optional().default(false),
  // In-kind donation paperwork: the money side goes to donations instead of expense; the goods
  // load into inventory like any other receipt. Defaults false (a purchase).
  isInKind: z.boolean().optional().default(false),
  // Absent when the receipt never waited on finance review.
  financeReview: CompletedReceiptFinanceReviewSchema.optional(),
  // The receipt org's settings hold this receipt's tax for finance review (tax-exempt org,
  // review-with-tax on, tax above zero, not in-kind).
  taxReviewRequired: z.boolean().optional(),
  lineItems: z.array(CompletedReceiptLineItemSchema).min(1),
});

export type CompletedReceiptLineItem = z.infer<typeof CompletedReceiptLineItemSchema>;
export type CompletedReceipt = z.infer<typeof CompletedReceiptSchema>;
export type CompletedReceiptFinanceReview = z.infer<typeof CompletedReceiptFinanceReviewSchema>;
