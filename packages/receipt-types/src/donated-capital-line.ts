import { z } from "zod";
import { MAX_LINE_QUANTITY } from "./completed-receipt";

/**
 * Capital-send line rules: an accepted gift line as expense's capital review takes it, its cost
 * including its share of tax and shipping. Donations checks its lines with this schema before
 * sending, and expense checks them again on receipt.
 */
export const DonatedCapitalLineSchema = z.object({
  giftSource: z.enum(["receipt", "manual"]),
  giftId: z.number().int().positive(),
  giftLineId: z.number().int().positive(),
  description: z.string(),
  quantity: z.number().positive().max(MAX_LINE_QUANTITY),
  costCents: z.number().int().nonnegative(),
  acquisitionDate: z.string().nullable(),
  budgetOwnerId: z.number().int().positive(),
});
export type DonatedCapitalLine = z.infer<typeof DonatedCapitalLineSchema>;
