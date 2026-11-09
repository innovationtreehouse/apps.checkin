import { z } from "zod";

export const DONOR_NAME_MAX = 100;
export const DONOR_COMPANY_MAX = 200;

/**
 * X13 donor rules. Upload, the receipt's donor sync and donations all check with this schema,
 * so a donor upload accepts is one donations accepts. Names are trimmed; blank is refused.
 */
export const InKindDonorSchema = z.object({
  firstName: z.string().trim().min(1).max(DONOR_NAME_MAX),
  lastName: z.string().trim().min(1).max(DONOR_NAME_MAX),
  companyName: z.string().trim().max(DONOR_COMPANY_MAX).nullable(),
});
export type InKindDonor = z.infer<typeof InKindDonorSchema>;
