/**
 * ReceivedOrgEvent workflow machine.
 *
 * Models the processing lifecycle of events fetched from the global catalog server.
 *
 * States:
 *   pending ──PROCESS_SUCCESS──► processed (final)
 *   pending ──PROCESS_FAIL─────► failed
 *   failed  ──PROCESS_SUCCESS──► processed (final)
 *
 * Note: failed → failed (re-failure on retry) is NOT modeled as a machine
 * transition. It is an idempotent persistence operation performed directly
 * by the poller. The machine only validates progression transitions.
 *
 * Authority split:
 *   Machine  — defines legal processing transitions; blocks re-processing
 *              of already-processed events; documents workflow topology
 *   Poller   — fetches events, calls processEvent(), calls updateStatus()
 *              after asserting via machine (except for failed→failed re-write)
 *   Database — enforces id uniqueness (INSERT OR IGNORE semantics via exists())
 */

import { setup } from "xstate";
import type { ReceivedOrgEventStatus } from "../lib/db/schema";
import type { ReceivedOrgEventEvent, ReceivedOrgEventEventType } from "./received-org-event.events";
import { makeWorkflowInvariants } from '@inventory/workflows';

export const receivedOrgEventMachine = setup({
  types: {
    events: {} as ReceivedOrgEventEvent,
  },
}).createMachine({
  id: "receivedOrgEvent",
  initial: "pending",
  states: {
    pending: {
      on: {
        PROCESS_SUCCESS: "processed",
        PROCESS_FAIL: "failed",
      },
    },
    failed: {
      on: {
        PROCESS_SUCCESS: "processed",
        // PROCESS_FAIL from failed is intentionally absent:
        // re-failure on retry is an idempotent write, not a workflow transition.
      },
    },
    processed: { type: "final" },
  },
});

const { assertLegalTransition, resolveNextState } = makeWorkflowInvariants<object, ReceivedOrgEventEvent>(
  receivedOrgEventMachine,
);

/**
 * Assert that `event` is a legal transition from `currentStatus` and return the next state.
 * Throws WorkflowTransitionError if illegal (e.g., re-processing a "processed" event).
 *
 * Does NOT validate failed → failed (that case is intentionally skipped by the poller).
 */
export function assertReceivedOrgEventTransition(
  currentStatus: ReceivedOrgEventStatus,
  event: ReceivedOrgEventEventType,
): ReceivedOrgEventStatus {
  assertLegalTransition(currentStatus, { type: event }, {});
  return resolveNextState(currentStatus, { type: event }, {}) as ReceivedOrgEventStatus;
}
