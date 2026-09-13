import { setup } from "xstate";
import type { ItemReferenceProposalStatus } from "../db/schema";
import type { ItemReferenceProposalEvent, ItemReferenceProposalEventType } from "./item-reference-proposal.events";
import { makeWorkflowInvariants } from '@inventory/workflows';

// States mirror itemReferenceProposalStatusEnum from db/schema.

export const itemReferenceProposalMachine = setup({
  types: {
    events: {} as ItemReferenceProposalEvent,
  },
}).createMachine({
  id: "itemReferenceProposal",
  initial: "pending",
  states: {
    pending: {
      on: {
        APPROVE: "approved",
        REJECT: "rejected",
        SUPERSEDE: "superseded",
      },
    },
    approved: { type: "final" as const },
    rejected: { type: "final" as const },
    superseded: { type: "final" as const },
  },
});

const { assertLegalTransition, resolveNextState } = makeWorkflowInvariants<object, ItemReferenceProposalEvent>(itemReferenceProposalMachine);

export function assertItemReferenceProposalTransition(
  currentStatus: ItemReferenceProposalStatus,
  event: ItemReferenceProposalEventType,
): ItemReferenceProposalStatus {
  const evt = { type: event } as ItemReferenceProposalEvent;
  assertLegalTransition(currentStatus, evt, {});
  return resolveNextState(currentStatus, evt, {}) as ItemReferenceProposalStatus;
}
