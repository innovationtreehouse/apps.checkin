import { setup } from "xstate";
import type { ConflictResolution } from "@/db/schema";
import type { ConflictResolutionEvent } from "./conflict-resolution.events";
import { makeWorkflowInvariants } from '@inventory/workflows';

export type ConflictResolutionStatus = "open" | ConflictResolution;

// "open" is derived (resolvedAt === null); terminal states mirror conflictResolutionEnum.
// Services map the DB row to the current state before calling assertConflictResolutionTransition.

export const conflictResolutionMachine = setup({
  types: {
    events: {} as ConflictResolutionEvent,
  },
}).createMachine({
  id: "conflictResolution",
  initial: "open",
  states: {
    open: {
      on: {
        RESOLVE: [
          {
            target: "keep_existing",
            guard: ({ event }) => event.resolution === "keep_existing",
          },
          {
            target: "use_proposed",
            guard: ({ event }) => event.resolution === "use_proposed",
          },
        ],
      },
    },
    keep_existing: { type: "final" as const },
    use_proposed: { type: "final" as const },
  },
});

const { assertLegalTransition, resolveNextState } = makeWorkflowInvariants<object, ConflictResolutionEvent>(conflictResolutionMachine);

export function assertConflictResolutionTransition(
  currentStatus: ConflictResolutionStatus,
  event: ConflictResolutionEvent,
): ConflictResolutionStatus {
  assertLegalTransition(currentStatus, event, {});
  return resolveNextState(currentStatus, event, {}) as ConflictResolutionStatus;
}
