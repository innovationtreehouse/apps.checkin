// ── Intake pipeline ───────────────────────────────────────────────────────────

export type RunPipelineEvent            = { type: 'RUN_PIPELINE' };
export type DuplicateClearedEvent       = { type: 'DUPLICATE_CLEARED' };
export type ResubmitEvent               = { type: 'RESUBMIT' };
export type FinancialApprovedEvent      = { type: 'FINANCIAL_APPROVED' };
export type SubmitterConfirmedEvent     = { type: 'SUBMITTER_CONFIRMED' };
export type SubmitterDiscardedEvent     = { type: 'SUBMITTER_DISCARDED' };

// ── OCR events ────────────────────────────────────────────────────────────────

export type OcrRetryEvent     = { type: 'OCR_RETRY' };
export type OcrSucceededEvent = { type: 'OCR_SUCCEEDED' };
export type OcrFailedEvent    = { type: 'OCR_FAILED' };

// ── Universal ─────────────────────────────────────────────────────────────────

export type DiscardEvent = { type: 'DISCARD' };
export type RejectEvent  = { type: 'REJECT' };

// ── State names ───────────────────────────────────────────────────────────────

export type ReceiptState =
  | 'uploaded'
  | 'auto_upload'
  | 'ocr_failed'
  | 'duplicate_flagged'
  | 'validation_failed'
  | 'submitter_review'
  | 'financial_review'
  | 'flow_error'
  | 'receipt_finalized'
  | 'discarded'
  | 'rejected';

// ── Union ─────────────────────────────────────────────────────────────────────

export type ReceiptEvent =
  | RunPipelineEvent
  | DuplicateClearedEvent
  | ResubmitEvent
  | FinancialApprovedEvent
  | SubmitterConfirmedEvent
  | SubmitterDiscardedEvent
  | OcrRetryEvent
  | OcrSucceededEvent
  | OcrFailedEvent
  | DiscardEvent
  | RejectEvent;
