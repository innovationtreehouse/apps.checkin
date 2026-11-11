import { z } from 'zod';

const DisbursementItemV1 = z.object({
  type: z.enum(['donation', 'match', 'fees']),
  account: z.string(),
  // The rule's QuickBooks account id, fixed when the batch finished; absent on batches finished
  // before rules named accounts. A batch finished since fees reduced income has no fees item.
  accountId: z.string().optional(),
  // Integer cents, net of the row's fee part on a donation or match. Never a fractional float.
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
