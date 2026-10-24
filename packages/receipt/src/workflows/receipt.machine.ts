import { setup } from 'xstate';
import type { ReceiptEvent } from './receipt.events';
import type { ReceiptMachineContext } from './receipt.guards';
import { NEUTRAL_CONTEXT, receiptGuards } from './receipt.guards';

export const receiptMachine = setup({
  types: {
    context: {} as ReceiptMachineContext,
    events: {} as ReceiptEvent,
  },
  guards: receiptGuards,
}).createMachine({
  id: 'receipt',
  initial: 'uploaded',
  context: NEUTRAL_CONTEXT,

  states: {

    // ── Intake pipeline ─────────────────────────────────────────────────────

    uploaded: {
      on: {
        // Guards evaluated in priority order — first match wins.
        RUN_PIPELINE: [
          { guard: 'isDuplicate',          target: 'duplicate_flagged' },
          { guard: 'mathInvalid',          target: 'validation_failed' },
          { guard: 'needsSubmitterReview', target: 'submitter_review'  },
          { guard: 'needsFinancialReview', target: 'financial_review'  },
          {                                target: 'receipt_finalized' },
        ],
        DISCARD: { target: 'discarded' },
      },
    },

    auto_upload: {
      on: {
        OCR_SUCCEEDED: { target: 'uploaded'   },
        OCR_FAILED:    { target: 'ocr_failed' },
        DISCARD:       { target: 'discarded'  },
      },
    },

    ocr_failed: {
      on: {
        OCR_RETRY: { target: 'auto_upload' },
        DISCARD:   { target: 'discarded'   },
      },
    },

    duplicate_flagged: {
      on: {
        DUPLICATE_CLEARED: { target: 'uploaded'  },
        DISCARD:           { target: 'discarded' },
      },
    },

    validation_failed: {
      on: {
        RESUBMIT: { target: 'uploaded'  },
        DISCARD:  { target: 'discarded' },
      },
    },

    submitter_review: {
      on: {
        SUBMITTER_CONFIRMED: { target: 'uploaded'  },
        SUBMITTER_DISCARDED: { target: 'discarded' },
        DISCARD:             { target: 'discarded' },
      },
    },

    financial_review: {
      on: {
        FINANCIAL_APPROVED: { target: 'uploaded'  },
        REJECT:             { target: 'rejected'  },
        DISCARD:            { target: 'discarded' },
      },
    },

    flow_error: {
      on: {
        RUN_PIPELINE: [
          { guard: 'isDuplicate',          target: 'duplicate_flagged' },
          { guard: 'mathInvalid',          target: 'validation_failed' },
          { guard: 'needsSubmitterReview', target: 'submitter_review'  },
          { guard: 'needsFinancialReview', target: 'financial_review'  },
          {                                target: 'receipt_finalized' },
        ],
        DISCARD: { target: 'discarded' },
      },
    },

    // ── Terminal states ─────────────────────────────────────────────────────

    receipt_finalized: {
      type: 'final' as const,
    },

    discarded: {
      type: 'final' as const,
    },

    rejected: {
      type: 'final' as const,
    },
  },
});
