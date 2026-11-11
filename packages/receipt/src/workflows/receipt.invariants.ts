import { makeWorkflowInvariants, WorkflowTransitionError } from '@checkin/workflows';
import { receiptMachine } from './receipt.machine';
import type { ReceiptEvent } from './receipt.events';
import type { ReceiptMachineContext } from './receipt.guards';
import { NEUTRAL_CONTEXT } from './receipt.guards';

export { WorkflowTransitionError, NEUTRAL_CONTEXT };

const invariants = makeWorkflowInvariants<ReceiptMachineContext, ReceiptEvent>(receiptMachine);

export const { resolveNextState, assertExpectedState, isLegalTransition, legalEventTypes, isTerminalState } = invariants;

export function assertLegalTransition(
  currentState: string,
  event: ReceiptEvent,
  context: ReceiptMachineContext = NEUTRAL_CONTEXT,
): void {
  invariants.assertLegalTransition(currentState, event, context);
}
