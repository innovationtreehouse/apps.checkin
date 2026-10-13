/**
 * ProvisionalItem workflow machine.
 *
 * States:
 *   pending ──APPROVE──────────► approved        (final)
 *   pending ──REJECT────────────► rejected        (final)
 *   pending ──MAP_TO_EXISTING──► mapped_to_existing (final)
 *
 * Authority split:
 *   Machine  — validates legal transitions
 *   Service  — executes mergeOrgItems, writes DB, emits log entries
 *   Database — enforces FK integrity, uniqueness
 */

import { setup, createActor } from "xstate";
import type { ProvisionalItemStatus } from "../lib/db/schema";
import type { ProvisionalItemEvent, ProvisionalItemEventType } from "./provisional-item.events";
import { WorkflowTransitionError } from '@inventory/workflows';

export const provisionalItemMachine = setup({
  types: {
    events: {} as ProvisionalItemEvent,
  },
}).createMachine({
  id: "provisionalItem",
  initial: "pending",
  states: {
    pending: {
      on: {
        APPROVE: "approved",
        REJECT: "rejected",
        MAP_TO_EXISTING: "mapped_to_existing",
      },
    },
    approved: { type: "final" },
    rejected: { type: "final" },
    mapped_to_existing: { type: "final" },
  },
});

/**
 * Assert that `event` is a legal transition from `currentStatus`.
 * Returns the next status string.
 * Throws WorkflowTransitionError if the transition is illegal.
 */
export function assertProvisionalTransition(
  currentStatus: ProvisionalItemStatus,
  event: ProvisionalItemEventType,
): ProvisionalItemStatus {
  const snapshot = provisionalItemMachine.resolveState({ value: currentStatus });
  const actor = createActor(provisionalItemMachine, { snapshot });
  actor.start();
  actor.send({ type: event });
  const next = actor.getSnapshot();
  actor.stop();

  if (next.value === currentStatus) {
    throw new WorkflowTransitionError(currentStatus, event, "provisionalItem");
  }

  return next.value as ProvisionalItemStatus;
}
