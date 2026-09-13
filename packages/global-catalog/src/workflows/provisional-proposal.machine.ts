import { setup } from "xstate";
import type { ProvisionalItemStatus } from "../db/schema";
import type { ProvisionalProposalEvent, ProvisionalProposalEventType } from "./provisional-proposal.events";
import { makeWorkflowInvariants } from '@inventory/workflows';

// States mirror provisionalItemProposalStatusEnum from db/schema.

export type ProvisionalProposalContext = {
  hasCategoryResolved: boolean;
  hasSubcategoryResolved: boolean;
};

export const provisionalProposalMachine = setup({
  types: {
    context: {} as ProvisionalProposalContext,
    events: {} as ProvisionalProposalEvent,
  },
  guards: {
    hasRequiredApprovalFields: ({ context }) =>
      context.hasCategoryResolved && context.hasSubcategoryResolved,
  },
}).createMachine({
  id: "provisionalProposal",
  context: { hasCategoryResolved: false, hasSubcategoryResolved: false },
  initial: "pending",
  states: {
    pending: {
      on: {
        APPROVE: {
          target: "approved",
          guard: "hasRequiredApprovalFields",
        },
        REJECT: "rejected",
        MAP_TO_EXISTING: "mapped_to_existing",
      },
    },
    approved: { type: "final" as const },
    rejected: { type: "final" as const },
    mapped_to_existing: { type: "final" as const },
  },
});

const { assertLegalTransition, resolveNextState } = makeWorkflowInvariants<ProvisionalProposalContext, ProvisionalProposalEvent>(provisionalProposalMachine);

/**
 * Context is required for APPROVE (hasCategoryResolved, hasSubcategoryResolved must be true).
 * For REJECT and MAP_TO_EXISTING the guards do not run; context may be omitted.
 */
export function assertProvisionalProposalTransition(
  currentStatus: ProvisionalItemStatus,
  event: ProvisionalProposalEventType,
  context: ProvisionalProposalContext = { hasCategoryResolved: false, hasSubcategoryResolved: false },
): ProvisionalItemStatus {
  const evt = { type: event } as ProvisionalProposalEvent;
  assertLegalTransition(currentStatus, evt, context);
  return resolveNextState(currentStatus, evt, context) as ProvisionalItemStatus;
}
