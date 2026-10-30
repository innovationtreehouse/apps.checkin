import type { ReceiptEvent } from './receipt.events';

export type ReceiptMachineContext = {
  detailsMissing: boolean;
  isDuplicate: boolean;
  mathValid: boolean;
  needsReimbursement: boolean;
  cameByEmail: boolean;
  readByOcr: boolean;
  submitterReviewed: boolean;
  financialApproved: boolean;
  needsFinancialReview: boolean;
};

export const NEUTRAL_CONTEXT: ReceiptMachineContext = {
  detailsMissing: false,
  isDuplicate: false,
  mathValid: true,
  needsReimbursement: false,
  cameByEmail: false,
  readByOcr: false,
  submitterReviewed: false,
  financialApproved: false,
  needsFinancialReview: false,
};

type GuardArgs = { context: ReceiptMachineContext; event: ReceiptEvent };

export const receiptGuards = {
  // A receipt without its retailer, date or total goes back to its submitter before any other check.
  detailsMissing:       ({ context }: GuardArgs) => context.detailsMissing,
  isDuplicate:         ({ context }: GuardArgs) => context.isDuplicate,
  mathInvalid:          ({ context }: GuardArgs) => !context.mathValid,
  // Email cannot carry reimbursement, in-kind or donor, and OCR output is a proposal, so a mailed
  // or machine-read receipt waits for its uploader to confirm it.
  needsSubmitterReview: ({ context }: GuardArgs) =>
    (context.cameByEmail || context.readByOcr || context.needsReimbursement) && !context.submitterReviewed,
  needsFinancialReview: ({ context }: GuardArgs) => !context.financialApproved && context.needsFinancialReview,
};
