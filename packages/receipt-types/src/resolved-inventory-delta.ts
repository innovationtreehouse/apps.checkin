import { z } from "zod";

export const ResolvedInventoryDeltaLineItemSchema = z.object({
  lineItemId: z.number().int(),
  gtin13: z.string(),
  quantityDelta: z.number().int().positive(),
  isDelayed: z.boolean(),
  // Set when gtin13 is a provisional GTIN awaiting catalog resolution.
  // provisionalName carries the receipt line description so the receiving
  // app can create a placeholder tracking record for later remap.
  isProvisional: z.boolean().optional(),
  provisionalName: z.string().optional(),
  // Conversion factor = inventory units per receipt-line unit (integer,
  // positive). The producer sends RAW quantityDelta + this factor; the
  // receiving app multiplies (quantityDelta * conversionFactor) when writing
  // the live total, and records raw/factor/derived in its audit log.
  // Defaults to 1 so pre-conversion-era payloads still parse (forward-only).
  conversionFactor: z.number().int().positive().default(1),
  // Stamp of the catalog factor revision this delta was computed under.
  // Audit/detection only — never triggers retroactive recompute.
  conversionVersion: z.number().int().positive().default(1),
});

export const ResolvedInventoryDeltaSchema = z.object({
  receiptId: z.string(),
  orgId: z.string(),
  retailer: z.string().nullable(),
  lineItems: z.array(ResolvedInventoryDeltaLineItemSchema).min(1),
});

export type ResolvedInventoryDeltaLineItem = z.infer<typeof ResolvedInventoryDeltaLineItemSchema>;
export type ResolvedInventoryDelta = z.infer<typeof ResolvedInventoryDeltaSchema>;
