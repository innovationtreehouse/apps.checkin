import { makeWorkflowInvariants } from '@inventory/workflows';
import { expenseMachine } from './expense.machine';
import type { ExpenseEvent } from './expense.events';
import type { ExpenseMachineContext } from './expense.guards';
import { NEUTRAL_CONTEXT } from './expense.guards';

const invariants = makeWorkflowInvariants<ExpenseMachineContext, ExpenseEvent>(expenseMachine);

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

export function assertExpectedState(
  currentState: string,
  event: ExpenseEvent,
  context: ExpenseMachineContext,
  expectedNext: string,
): void {
  invariants.assertExpectedState(currentState, event, context, expectedNext);
}

export function isLegalTransition(currentState: string, eventType: string): boolean {
  return invariants.isLegalTransition(currentState, eventType);
}

export function legalEventTypes(state: string): string[] {
  return invariants.legalEventTypes(state);
}

export function isTerminalState(state: string): boolean {
  return invariants.isTerminalState(state);
}
