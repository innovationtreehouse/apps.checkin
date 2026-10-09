import { describe, it, expect } from 'vitest';
import { createActor } from 'xstate';
import { disbursementMachine, STATES } from '../../workflows/disbursement.machine';
import { EVENTS } from '../../workflows/disbursement.events';
import {
  assertLegalTransition,
  assertExpectedState,
  isLegalTransition,
  isTerminalState,
} from '../../workflows/disbursement.invariants';
import { WorkflowTransitionError } from '@inventory/workflows';
import { NEUTRAL_CONTEXT } from '../../workflows/disbursement.guards';

// ── Helpers ───────────────────────────────────────────────────────────────────

function transitionWith(fromState: string, event: Parameters<ReturnType<typeof createActor>['send']>[0]) {
  const snapshot = disbursementMachine.resolveState({ value: fromState, context: NEUTRAL_CONTEXT });
  const actor = createActor(disbursementMachine, { snapshot });
  actor.start();
  actor.send(event);
  const next = String(actor.getSnapshot().value);
  actor.stop();
  return next;
}

// ── Ownership pipeline ────────────────────────────────────────────────────────

describe('ownership pipeline', () => {
  it('advances to processing when OWNER_ASSIGNED with allReady=true', () => {
    expect(
      transitionWith(STATES.AWAITING_OWNERSHIP, { type: EVENTS.OWNER_ASSIGNED, allReady: true })
    ).toBe(STATES.PROCESSING);
  });

  it('stays in awaiting_ownership when OWNER_ASSIGNED with allReady=false (guard blocks)', () => {
    expect(
      transitionWith(STATES.AWAITING_OWNERSHIP, { type: EVENTS.OWNER_ASSIGNED, allReady: false })
    ).toBe(STATES.AWAITING_OWNERSHIP);
  });
});

// ── Processing outcomes ───────────────────────────────────────────────────────

describe('processing outcomes', () => {
  it('completes the disbursement when account determination succeeds', () => {
    expect(
      transitionWith(STATES.PROCESSING, { type: EVENTS.PROCESS_SUCCEEDED })
    ).toBe(STATES.COMPLETED);
  });

  it('puts the disbursement on hold when account determination is unresolved', () => {
    expect(
      transitionWith(STATES.PROCESSING, { type: EVENTS.ACCOUNT_UNRESOLVED })
    ).toBe(STATES.ON_HOLD);
  });
});

// ── Hold resolution ───────────────────────────────────────────────────────────

describe('hold resolution', () => {
  it('re-enters processing when finance resubmits a held disbursement', () => {
    expect(
      transitionWith(STATES.ON_HOLD, { type: EVENTS.HOLD_RESUBMITTED })
    ).toBe(STATES.PROCESSING);
  });

  it('can cycle between on_hold and processing until account determination resolves', () => {
    expect(transitionWith(STATES.ON_HOLD, { type: EVENTS.HOLD_RESUBMITTED })).toBe(STATES.PROCESSING);
    expect(transitionWith(STATES.PROCESSING, { type: EVENTS.ACCOUNT_UNRESOLVED })).toBe(STATES.ON_HOLD);
  });
});

// ── Terminal state ────────────────────────────────────────────────────────────

describe('terminal states', () => {
  it('completed is a terminal state', () => {
    expect(isTerminalState(STATES.COMPLETED)).toBe(true);
  });

  it('completed rejects all events — no further transitions are possible', () => {
    expect(isLegalTransition(STATES.COMPLETED, EVENTS.OWNER_ASSIGNED)).toBe(false);
    expect(isLegalTransition(STATES.COMPLETED, EVENTS.PROCESS_SUCCEEDED)).toBe(false);
    expect(isLegalTransition(STATES.COMPLETED, EVENTS.ACCOUNT_UNRESOLVED)).toBe(false);
    expect(isLegalTransition(STATES.COMPLETED, EVENTS.HOLD_RESUBMITTED)).toBe(false);
  });
});

// ── assertLegalTransition ─────────────────────────────────────────────────────

describe('assertLegalTransition', () => {
  it('awaiting_ownership accepts OWNER_ASSIGNED', () => {
    expect(() =>
      assertLegalTransition(STATES.AWAITING_OWNERSHIP, { type: EVENTS.OWNER_ASSIGNED, allReady: true })
    ).not.toThrow();
  });

  it('throws WorkflowTransitionError for an event not defined in the current state', () => {
    expect(() =>
      assertLegalTransition(STATES.AWAITING_OWNERSHIP, { type: EVENTS.HOLD_RESUBMITTED })
    ).toThrow(WorkflowTransitionError);
  });

  it('throws for any event on a terminal state', () => {
    expect(() =>
      assertLegalTransition(STATES.COMPLETED, { type: EVENTS.PROCESS_SUCCEEDED })
    ).toThrow(WorkflowTransitionError);
  });
});

// ── assertExpectedState ───────────────────────────────────────────────────────

describe('assertExpectedState', () => {
  it('does not throw when the machine agrees with the service-computed next state', () => {
    expect(() =>
      assertExpectedState(
        STATES.AWAITING_OWNERSHIP,
        { type: EVENTS.OWNER_ASSIGNED, allReady: true },
        NEUTRAL_CONTEXT,
        STATES.PROCESSING,
      )
    ).not.toThrow();
  });

  it('throws on state divergence between machine and service logic', () => {
    expect(() =>
      assertExpectedState(
        STATES.AWAITING_OWNERSHIP,
        { type: EVENTS.OWNER_ASSIGNED, allReady: true },
        NEUTRAL_CONTEXT,
        STATES.ON_HOLD,
      )
    ).toThrow('disbursement state divergence');
  });
});

// ── isLegalTransition (topology only) ────────────────────────────────────────

describe('isLegalTransition', () => {
  it('returns true for an event defined in that state', () => {
    expect(isLegalTransition(STATES.ON_HOLD, EVENTS.HOLD_RESUBMITTED)).toBe(true);
  });

  it('returns false for an event not defined in that state', () => {
    expect(isLegalTransition(STATES.ON_HOLD, EVENTS.OWNER_ASSIGNED)).toBe(false);
  });

  it('returns false for an unknown state', () => {
    expect(isLegalTransition('nonexistent_state', EVENTS.OWNER_ASSIGNED)).toBe(false);
  });
});
