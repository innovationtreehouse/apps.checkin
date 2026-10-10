import { describe, it, expect } from 'vitest';
import { createActor } from 'xstate';
import { receiptMachine } from '../../workflows/receipt.machine';
import {
  assertLegalTransition,
  assertExpectedState,
  isLegalTransition,
  isTerminalState,
} from '../../workflows/receipt.invariants';
import type { ReceiptMachineContext } from '../../workflows/receipt.guards';
import { WorkflowTransitionError } from '@inventory/workflows';
import { NEUTRAL_CONTEXT } from '../../workflows/receipt.guards';

// ── Helpers ───────────────────────────────────────────────────────────────────

function transition(fromState: string, eventType: string, ctx: ReceiptMachineContext = NEUTRAL_CONTEXT, eventExtra: Record<string, unknown> = {}) {
  const snapshot = receiptMachine.resolveState({ value: fromState, context: ctx });
  const actor = createActor(receiptMachine, { snapshot });
  actor.start();
  actor.send({ type: eventType, ...eventExtra } as Parameters<typeof actor.send>[0]);
  const next = String(actor.getSnapshot().value);
  actor.stop();
  return next;
}

const ctx = {
  dup:       { ...NEUTRAL_CONTEXT, isDuplicate: true },
  badMath:   { ...NEUTRAL_CONTEXT, mathValid: false },
  reimburse: { ...NEUTRAL_CONTEXT, needsReimbursement: true },
  finReview: { ...NEUTRAL_CONTEXT, needsFinancialReview: true },
  clear:     NEUTRAL_CONTEXT,
  finApproved: { ...NEUTRAL_CONTEXT, financialApproved: true, needsFinancialReview: true },
  reimburseConfirmed: { ...NEUTRAL_CONTEXT, needsReimbursement: true, submitterReviewed: true },
};

// ── RUN_PIPELINE guard priority ───────────────────────────────────────────────

describe('RUN_PIPELINE guard priority', () => {
  it('duplicate takes priority over all', () => {
    const c = { ...ctx.dup, mathValid: false };
    expect(transition('uploaded', 'RUN_PIPELINE', c)).toBe('duplicate_flagged');
  });

  it('math check fires when no duplicate', () => {
    expect(transition('uploaded', 'RUN_PIPELINE', ctx.badMath)).toBe('validation_failed');
  });

  it('submitter_review fires when needs reimbursement and not reviewed', () => {
    expect(transition('uploaded', 'RUN_PIPELINE', ctx.reimburse)).toBe('submitter_review');
  });

  it('submitter_review skipped when already reviewed', () => {
    expect(transition('uploaded', 'RUN_PIPELINE', ctx.reimburseConfirmed)).toBe('receipt_finalized');
  });

  it('financial_review fires on trigger', () => {
    expect(transition('uploaded', 'RUN_PIPELINE', ctx.finReview)).toBe('financial_review');
  });

  it('financial_review skipped when already approved', () => {
    expect(transition('uploaded', 'RUN_PIPELINE', ctx.finApproved)).toBe('receipt_finalized');
  });

  it('falls through to receipt_finalized when all guards pass', () => {
    expect(transition('uploaded', 'RUN_PIPELINE', ctx.clear)).toBe('receipt_finalized');
  });
});

// ── Intake pipeline transitions ───────────────────────────────────────────────

describe('intake pipeline transitions', () => {
  it('duplicate_flagged → DUPLICATE_CLEARED → uploaded', () => {
    expect(transition('duplicate_flagged', 'DUPLICATE_CLEARED')).toBe('uploaded');
  });

  it('validation_failed → RESUBMIT → uploaded', () => {
    expect(transition('validation_failed', 'RESUBMIT')).toBe('uploaded');
  });

  it('financial_review → FINANCIAL_APPROVED → uploaded', () => {
    expect(transition('financial_review', 'FINANCIAL_APPROVED')).toBe('uploaded');
  });

  it('financial_review → REJECT → rejected', () => {
    expect(transition('financial_review', 'REJECT')).toBe('rejected');
  });

  it('REJECT is illegal from states other than financial_review', () => {
    const nonRejectable = [
      'uploaded', 'auto_upload', 'ocr_failed', 'duplicate_flagged',
      'validation_failed', 'submitter_review', 'receipt_finalized', 'discarded', 'rejected',
    ];
    for (const state of nonRejectable) {
      expect(isLegalTransition(state, 'REJECT')).toBe(false);
    }
  });

  it('submitter_review → SUBMITTER_CONFIRMED → uploaded', () => {
    expect(transition('submitter_review', 'SUBMITTER_CONFIRMED')).toBe('uploaded');
  });

  it('submitter_review → SUBMITTER_DISCARDED → discarded', () => {
    expect(transition('submitter_review', 'SUBMITTER_DISCARDED')).toBe('discarded');
  });

  it('ocr_failed → OCR_RETRY → auto_upload', () => {
    expect(transition('ocr_failed', 'OCR_RETRY')).toBe('auto_upload');
  });

  it('auto_upload → OCR_SUCCEEDED → uploaded', () => {
    expect(transition('auto_upload', 'OCR_SUCCEEDED')).toBe('uploaded');
  });

  it('auto_upload → OCR_FAILED → ocr_failed', () => {
    expect(transition('auto_upload', 'OCR_FAILED')).toBe('ocr_failed');
  });
});

// ── DISCARD from all non-terminal states ──────────────────────────────────────

describe('DISCARD universal event', () => {
  const discardableStates = [
    'uploaded', 'auto_upload', 'ocr_failed', 'duplicate_flagged',
    'validation_failed', 'submitter_review', 'financial_review',
  ];

  for (const state of discardableStates) {
    it(`${state} → DISCARD → discarded`, () => {
      expect(transition(state, 'DISCARD')).toBe('discarded');
    });
  }

  it('receipt_finalized does NOT allow DISCARD', () => {
    expect(isLegalTransition('receipt_finalized', 'DISCARD')).toBe(false);
  });
});

// ── Terminal state invariants ─────────────────────────────────────────────────

describe('terminal states', () => {
  const terminals = ['discarded', 'receipt_finalized', 'rejected'];

  for (const state of terminals) {
    it(`${state} is terminal`, () => {
      expect(isTerminalState(state)).toBe(true);
    });

    it(`${state} rejects DISCARD`, () => {
      expect(isLegalTransition(state, 'DISCARD')).toBe(false);
    });
  }
});

// ── assertLegalTransition ─────────────────────────────────────────────────────

describe('assertLegalTransition', () => {
  it('does not throw for legal transition', () => {
    expect(() =>
      assertLegalTransition('duplicate_flagged', { type: 'DUPLICATE_CLEARED' })
    ).not.toThrow();
  });

  it('throws for illegal transition', () => {
    expect(() =>
      assertLegalTransition('receipt_finalized', { type: 'DISCARD' })
    ).toThrow(WorkflowTransitionError);
  });

  it('throws for unknown event on valid state', () => {
    expect(() =>
      assertLegalTransition('uploaded', { type: 'FINANCIAL_APPROVED' } as Parameters<typeof assertLegalTransition>[1])
    ).toThrow(WorkflowTransitionError);
  });
});

// ── assertExpectedState ───────────────────────────────────────────────────────

describe('assertExpectedState', () => {
  it('does not throw when machine agrees', () => {
    expect(() =>
      assertExpectedState('duplicate_flagged', { type: 'DUPLICATE_CLEARED' }, NEUTRAL_CONTEXT, 'uploaded')
    ).not.toThrow();
  });

  it('throws when machine disagrees', () => {
    expect(() =>
      assertExpectedState('duplicate_flagged', { type: 'DUPLICATE_CLEARED' }, NEUTRAL_CONTEXT, 'financial_review')
    ).toThrow('receipt state divergence');
  });
});

// ── isLegalTransition (topology only) ────────────────────────────────────────

describe('isLegalTransition', () => {
  it('returns true for defined event in state', () => {
    expect(isLegalTransition('financial_review', 'FINANCIAL_APPROVED')).toBe(true);
  });

  it('returns false for undefined event in state', () => {
    expect(isLegalTransition('financial_review', 'QB_COMPLETE')).toBe(false);
  });

  it('returns false for unknown state', () => {
    expect(isLegalTransition('nonexistent_state', 'DISCARD')).toBe(false);
  });
});

// ── Email intake stops at submitter_review ────────────────────────────────────

describe('email intake', () => {
  const email = { ...NEUTRAL_CONTEXT, cameByEmail: true };

  it('a mailed receipt stops at submitter_review even when nothing is owed', () => {
    expect(transition('uploaded', 'RUN_PIPELINE', email)).toBe('submitter_review');
  });

  it('a mailed receipt finalizes once its uploader has reviewed it', () => {
    expect(transition('uploaded', 'RUN_PIPELINE', { ...email, submitterReviewed: true })).toBe('receipt_finalized');
  });

  it('an uploaded receipt that owes nothing skips submitter_review', () => {
    expect(transition('uploaded', 'RUN_PIPELINE', { ...NEUTRAL_CONTEXT, cameByEmail: false })).toBe('receipt_finalized');
  });
});
