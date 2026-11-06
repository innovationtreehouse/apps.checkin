import { z } from 'zod';

const DisbursementItemV1 = z.object({
  type: z.enum(['donation', 'match', 'fees']),
  account: z.string(),
  // The rule's QuickBooks account id, fixed when the batch finished; absent on fees and on batches
  // finished before rules named accounts.
  accountId: z.string().optional(),
  // Integer minor units (cents), matching the integer-cents discipline used end
  // to end (DB columns, CSV ingest, @checkin/money). Never a fractional float.
  amountCents: z.number().int(),
  transactionId: z.string(),
});

export const DisbursementPayloadV1 = z.object({
  version: z.literal(1),
  orgId: z.string(),
  disbursementId: z.string(),
  disbursementDate: z.string().nullable(),
  disbursementFrom: z.string().nullable(),
  items: z.array(DisbursementItemV1),
});

export type DisbursementPayloadV1 = z.infer<typeof DisbursementPayloadV1>;

export type DisbursementPayload = DisbursementPayloadV1;
