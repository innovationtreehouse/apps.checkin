import { makeWorkflowInvariants, WorkflowTransitionError } from '@inventory/workflows';
import { disbursementMachine, STATES } from './disbursement.machine';
import type { DisbursementEvent } from './disbursement.events';
import type { DisbursementMachineContext } from './disbursement.guards';
import { NEUTRAL_CONTEXT } from './disbursement.guards';

const invariants = makeWorkflowInvariants<DisbursementMachineContext, DisbursementEvent>(disbursementMachine);

/**
 * Assert the machine defines a handler for `eventType` in `currentState`.
 * Throws WorkflowTransitionError when it does not — turning an event the state
 * cannot accept into an explicit, rolled-back failure instead of XState's silent
 * no-op. This is a topology check, NOT a guard evaluation: a transition whose
 * guard legitimately holds the machine in place (e.g. OWNER_ASSIGNED before all
 * owners are ready) still has a handler and is therefore accepted.
 *
 * This is the runtime checkpoint that makes the machine authoritative over which
 * events may be applied in a given state.
 */
export function assertEventAccepted(currentState: string, eventType: string): void {
  if (!invariants.isLegalTransition(currentState, eventType)) {
    throw new WorkflowTransitionError(currentState, eventType, disbursementMachine.id);
  }
}

/**
 * True when `eventType` is not accepted in `currentState` *because the
 * disbursement has already advanced past the initial state where that trigger
 * applied* — i.e. a duplicate or redelivered trigger (e.g. a second
 * OWNER_ASSIGNED after the disbursement already entered processing/on_hold).
 *
 * Such replays are benign and should be absorbed as idempotent no-ops so that
 * at-least-once delivery and retries stay safe. They are deliberately distinct
 * from genuinely illegal events (e.g. HOLD_RESUBMITTED before anything was ever
 * held), which `assertEventAccepted` surfaces as errors.
 *
 * Assumption: triggers accepted in the initial state are one-shot — once the
 * machine leaves that state, re-receiving them is a replay, not a new intent.
 */
export function isConsumedTriggerReplay(currentState: string, eventType: string): boolean {
  return (
    currentState !== STATES.AWAITING_OWNERSHIP &&
    invariants.legalEventTypes(STATES.AWAITING_OWNERSHIP).includes(eventType)
  );
}

/**
 * Assert that sending `event` from `currentState` is a legal transition.
 * Throws WorkflowTransitionError if the machine has no handler.
 * Call BEFORE executing service logic — validates intent.
 */
export function assertLegalTransition(
  currentState: string,
  event: DisbursementEvent,
  context: DisbursementMachineContext = NEUTRAL_CONTEXT,
): void {
  invariants.assertLegalTransition(currentState, event, context);
}

/**
 * Assert that the machine agrees with the state the service is about to persist.
 * Throws on divergence. Call AFTER computing nextState, BEFORE writing to DB.
 */
export function assertExpectedState(
  currentState: string,
  event: DisbursementEvent,
  context: DisbursementMachineContext,
  expectedNext: string,
): void {
  invariants.assertExpectedState(currentState, event, context, expectedNext);
}

/**
 * Topology-only check: does `state` have any handler for `eventType`?
 * Does not evaluate guards — answers "is this event defined for this state?".
 */
export function isLegalTransition(currentState: string, eventType: string): boolean {
  return invariants.isLegalTransition(currentState, eventType);
}

/**
 * Returns the set of event types defined for the given state.
 */
export function legalEventTypes(state: string): string[] {
  return invariants.legalEventTypes(state);
}

/**
 * Returns true if `state` is a terminal state (no outbound transitions).
 */
export function isTerminalState(state: string): boolean {
  return invariants.isTerminalState(state);
}
