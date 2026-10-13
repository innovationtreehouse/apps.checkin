/**
 * Workflow-mapping state machine.
 *
 * Drives a received receipt from catalog resolution through downstream push.
 *
 * States:
 *   pending_review ──PROCEED────────────────► applying
 *   applying ──PUSH_SUCCEEDED───────────────► resolved  (final)
 *   applying ──PUSH_FAILED──────────────────► apply_failed
 *   applying ──RETRY────────────────────────► applying  (crash recovery)
 *   apply_failed ──RETRY────────────────────► applying
 *
 * Initial state set at intake:
 *   - any unrecognized line item  → pending_review
 *   - all items recognized        → applying  (skip catalog review)
 *
 * Unrecognized line items are proposed as provisional GTINs (see the
 * propose service) and the receipt proceeds straight through to applying —
 * it does not park waiting for catalog review. Downstream libraries track and
 * remap provisional GTINs themselves once the catalog resolves them.
 */

import { setup, createActor } from "xstate";
import type { ReceivedReceiptState } from "../db/schema";
import type { WorkflowMappingEvent, WorkflowMappingEventType } from "./workflow-mapping.events";
import { WorkflowTransitionError } from "@inventory/workflows";

export const workflowMappingMachine = setup({
  types: {
    events: {} as WorkflowMappingEvent,
  },
}).createMachine({
  id: "workflowMapping",
  initial: "pending_review",
  states: {
    pending_review: {
      on: {
        PROCEED: "applying",
      },
    },
    applying: {
      on: {
        PUSH_SUCCEEDED: "resolved",
        PUSH_FAILED:    "apply_failed",
        RETRY:          "applying",
      },
    },
    apply_failed: {
      on: {
        RETRY: "applying",
      },
    },
    resolved: { type: "final" },
  },
});

export function assertWorkflowMappingTransition(
  currentState: ReceivedReceiptState,
  event: WorkflowMappingEventType,
): ReceivedReceiptState {
  const snapshot = workflowMappingMachine.resolveState({ value: currentState });
  const actor = createActor(workflowMappingMachine, { snapshot });
  actor.start();
  actor.send({ type: event } as WorkflowMappingEvent);
  const next = actor.getSnapshot();
  actor.stop();

  if (!isWorkflowMappingTransitionLegal(currentState, event)) {
    throw new WorkflowTransitionError(currentState, event, "workflowMapping");
  }

  return next.value as ReceivedReceiptState;
}

export function initialReceiptState(hasUnrecognized: boolean): ReceivedReceiptState {
  return hasUnrecognized ? "pending_review" : "applying";
}

export function areAllLinesResolved(
  lineStatuses: { recognitionStatus: string }[],
): boolean {
  return lineStatuses.every(
    (ls) =>
      ls.recognitionStatus === "recognized" ||
      ls.recognitionStatus === "non_inventory" ||
      ls.recognitionStatus === "provisional",
  );
}

export function isWorkflowMappingTransitionLegal(
  currentState: ReceivedReceiptState,
  eventType: WorkflowMappingEventType,
): boolean {
  const states = workflowMappingMachine.config.states as
    | Record<string, { on?: Record<string, unknown> } | undefined>
    | undefined;
  const stateConfig = states?.[currentState];
  if (!stateConfig?.on) return false;
  return eventType in stateConfig.on;
}
