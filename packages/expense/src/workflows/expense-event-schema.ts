// ── Schema versioning convention ──────────────────────────────────────────────
// Every cross-service event schema carries a schemaVersion literal so consumers
// can reject payloads built against an incompatible version.  Increment the
// literal — and add a migration path — before any breaking field change.

import { z } from "zod";

export const QbLineItemSchema = z.object({
  lineItemId: z.number().int().positive(),
  description: z.string(),
  quantity: z.number().int().positive(),
  unitPriceCents: z.number().int().nonnegative(),
  totalPriceCents: z.number().int().nonnegative(),
  allocatedTaxCents: z.number().int().nonnegative(),
  allocatedShippingCents: z.number().int().nonnegative(),
  allocatedDiscountCents: z.number().int().nonnegative(),
  isDelayed: z.boolean(),
  isCapital: z.boolean(),
  capitalOwnerId: z.number().int().positive().nullable(),
  depreciationYears: z.number().int().positive().nullable(),
  account: z.string(),
});

export const QbExpenseEventSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string(),
    vendorName: z.string().nullable(),
    receiptDate: z.string().nullable(),
    receiptTotalCents: z.number().int().nonnegative(),
    orgId: z.string(),
    needsReimbursement: z.boolean(),
    /** Display text from the receipt; never names the payee. */
    reimbursementFor: z.string().nullable(),
    /** The checkin Person the conflict checks and sign-offs were run against: the payee. */
    reimburseePersonId: z.number().int().positive().nullable(),
    items: z.array(QbLineItemSchema),
  })
  .refine((e) => !e.needsReimbursement || e.reimburseePersonId !== null, {
    message: "a reimbursement event must name its reimburseePersonId",
    path: ["reimburseePersonId"],
  });

export type QbExpenseEvent = z.infer<typeof QbExpenseEventSchema>;
