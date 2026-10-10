import type { ReceiptEvent } from './receipt.events';

export type ReceiptMachineContext = {
  isDuplicate: boolean;
  mathValid: boolean;
  needsReimbursement: boolean;
  cameByEmail: boolean;
  submitterReviewed: boolean;
  financialApproved: boolean;
  needsFinancialReview: boolean;
};

export const NEUTRAL_CONTEXT: ReceiptMachineContext = {
  isDuplicate: false,
  mathValid: true,
  needsReimbursement: false,
  cameByEmail: false,
  submitterReviewed: false,
  financialApproved: false,
  needsFinancialReview: false,
};

type GuardArgs = { context: ReceiptMachineContext; event: ReceiptEvent };

export const receiptGuards = {
  isDuplicate:          ({ context }: GuardArgs) => context.isDuplicate,
  mathInvalid:          ({ context }: GuardArgs) => !context.mathValid,
  // Email cannot carry reimbursement, in-kind or donor, so a mailed receipt waits for its uploader.
  needsSubmitterReview: ({ context }: GuardArgs) =>
    (context.cameByEmail || context.needsReimbursement) && !context.submitterReviewed,
  needsFinancialReview: ({ context }: GuardArgs) => !context.financialApproved && context.needsFinancialReview,
};
