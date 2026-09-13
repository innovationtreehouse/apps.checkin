import { setup } from "xstate";
import type { ConversionChallengeStatus } from "../db/schema";
import type { ConversionChallengeEvent, ConversionChallengeEventType } from "./conversion-challenge.events";
import { makeWorkflowInvariants } from '@inventory/workflows';

// States mirror conversionChallengeStatusEnum from db/schema.
// If the enum gains a new value and this machine is not updated, tsc will surface
// unreachable states and missing coverage in machines.unit.test.ts.

export const conversionChallengeMachine = setup({
  types: {
    events: {} as ConversionChallengeEvent,
  },
}).createMachine({
  id: "conversionChallenge",
  initial: "pending",
  states: {
    pending: {
      on: {
        ACCEPT: "accepted",
        REJECT: "rejected",
      },
    },
    accepted: { type: "final" as const },
    rejected: { type: "final" as const },
  },
});

const { assertLegalTransition, resolveNextState } = makeWorkflowInvariants<object, ConversionChallengeEvent>(conversionChallengeMachine);

export function assertConversionChallengeTransition(
  currentStatus: ConversionChallengeStatus,
  event: ConversionChallengeEventType,
): ConversionChallengeStatus {
  const evt = { type: event } as ConversionChallengeEvent;
  assertLegalTransition(currentStatus, evt, {});
  return resolveNextState(currentStatus, evt, {}) as ConversionChallengeStatus;
}
