/**
 * InventoryMergeConflict workflow machine.
 *
 * States:
 *   pending ──RESOLVE──► resolved (final)
 *
 * Authority split:
 *   Machine  — validates legal transitions
 *   Service  — resolves quantities, updates orgItems, writes DB log
 *   Database — enforces FK integrity
 */

import { setup, createActor } from "xstate";
import type { MergeConflictStatus } from "../lib/db/schema";
import type { MergeConflictEvent, MergeConflictEventType } from "./merge-conflict.events";
import { WorkflowTransitionError } from '@inventory/workflows';

export const mergeConflictMachine = setup({
  types: {
    events: {} as MergeConflictEvent,
  },
}).createMachine({
  id: "mergeConflict",
  initial: "pending",
  states: {
    pending: {
      on: {
        RESOLVE: "resolved",
      },
    },
    resolved: { type: "final" },
  },
});

/**
 * Assert that `event` is a legal transition from `currentStatus`.
 * Returns the next status string.
 * Throws WorkflowTransitionError if the transition is illegal.
 */
export function assertMergeConflictTransition(
  currentStatus: MergeConflictStatus,
  event: MergeConflictEventType,
): MergeConflictStatus {
  const snapshot = mergeConflictMachine.resolveState({ value: currentStatus });
  const actor = createActor(mergeConflictMachine, { snapshot });
  actor.start();
  actor.send({ type: event });
  const next = actor.getSnapshot();
  actor.stop();

  if (next.value === currentStatus) {
    throw new WorkflowTransitionError(currentStatus, event, "mergeConflict");
  }

  return next.value as MergeConflictStatus;
}
