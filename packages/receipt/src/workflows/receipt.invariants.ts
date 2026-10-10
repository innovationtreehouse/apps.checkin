import { makeWorkflowInvariants, WorkflowTransitionError } from '@inventory/workflows';
import { receiptMachine } from './receipt.machine';
import type { ReceiptEvent } from './receipt.events';
import type { ReceiptMachineContext } from './receipt.guards';
import { NEUTRAL_CONTEXT } from './receipt.guards';

export { WorkflowTransitionError, NEUTRAL_CONTEXT };

const invariants = makeWorkflowInvariants<ReceiptMachineContext, ReceiptEvent>(receiptMachine);

export function resolveNextState(
  currentState: string,
  event: ReceiptEvent,
  context: ReceiptMachineContext,
): string {
  return invariants.resolveNextState(currentState, event, context);
}

/**
 * Assert that sending `event` from `currentState` is a legal transition.
 * Throws WorkflowTransitionError if the machine has no handler.
 * Call BEFORE executing service logic — validates intent.
 */
export function assertLegalTransition(
  currentState: string,
  event: ReceiptEvent,
  context: ReceiptMachineContext = NEUTRAL_CONTEXT,
): void {
  invariants.assertLegalTransition(currentState, event, context);
}

/**
 * Assert that the machine agrees with the state the service is about to persist.
 * Throws on divergence. Call AFTER computing nextState, BEFORE writing to DB.
 */
export function assertExpectedState(
  currentState: string,
  event: ReceiptEvent,
  context: ReceiptMachineContext,
  expectedNext: string,
): void {
  invariants.assertExpectedState(currentState, event, context, expectedNext);
}

/**
 * Topology-only check: does `state` have any handler for `eventType`?
 * Does not evaluate guards — answers "is this event defined for this state?".
 * Used by route handlers to validate state preconditions without needing context.
 */
export function isLegalTransition(currentState: string, eventType: string): boolean {
  return invariants.isLegalTransition(currentState, eventType);
}

/**
 * Returns the set of event types defined (not necessarily guard-passing) for the given state.
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
