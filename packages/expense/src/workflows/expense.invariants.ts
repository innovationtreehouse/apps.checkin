import { makeWorkflowInvariants } from '@checkin/workflows';
import { expenseMachine } from './expense.machine';
import type { ExpenseEvent } from './expense.events';
import type { ExpenseMachineContext } from './expense.guards';
import { NEUTRAL_CONTEXT } from './expense.guards';

const invariants = makeWorkflowInvariants<ExpenseMachineContext, ExpenseEvent>(expenseMachine);

export const { assertExpectedState, isLegalTransition, legalEventTypes, isTerminalState } = invariants;

/** Derive the next state the machine will land in given currentState + event + context. */
export function resolveNextState(
  currentState: string,
  event: ExpenseEvent,
  context: ExpenseMachineContext = NEUTRAL_CONTEXT,
): string {
  return invariants.resolveNextState(currentState, event, context);
}

export function assertLegalTransition(
  currentState: string,
  event: ExpenseEvent,
  context: ExpenseMachineContext = NEUTRAL_CONTEXT,
): void {
  invariants.assertLegalTransition(currentState, event, context);
}
