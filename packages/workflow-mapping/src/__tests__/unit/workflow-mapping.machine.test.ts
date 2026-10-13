import { describe, it, expect } from "vitest";
import { WorkflowTransitionError } from "@inventory/workflows";
import {
  assertWorkflowMappingTransition,
  isWorkflowMappingTransitionLegal,
} from "../../workflows/workflow-mapping.machine";
import type { ReceivedReceiptState } from "../../db/schema";
import type { WorkflowMappingEventType } from "../../workflows/workflow-mapping.events";

// Full legal transition map per the machine definition:
//   pending_review --PROCEED-------> applying
//   applying       --PUSH_SUCCEEDED-> resolved (final)
//   applying       --PUSH_FAILED----> apply_failed
//   applying       --RETRY----------> applying  (crash recovery)
//   apply_failed   --RETRY----------> applying
const LEGAL: Array<[ReceivedReceiptState, WorkflowMappingEventType, ReceivedReceiptState]> = [
  ["pending_review", "PROCEED", "applying"],
  ["applying", "PUSH_SUCCEEDED", "resolved"],
  ["applying", "PUSH_FAILED", "apply_failed"],
  ["apply_failed", "RETRY", "applying"],
  ["applying", "RETRY", "applying"],
];

const ALL_STATES: ReceivedReceiptState[] = [
  "pending_review",
  "applying",
  "apply_failed",
  "resolved",
];
const ALL_EVENTS: WorkflowMappingEventType[] = [
  "PROCEED",
  "PUSH_SUCCEEDED",
  "PUSH_FAILED",
  "RETRY",
];

// Every (state, event) pair NOT in the legal map is illegal.
const LEGAL_KEYS = new Set(LEGAL.map(([s, e]) => `${s}:${e}`));
const ILLEGAL: Array<[ReceivedReceiptState, WorkflowMappingEventType]> = [];
for (const s of ALL_STATES) {
  for (const e of ALL_EVENTS) {
    if (!LEGAL_KEYS.has(`${s}:${e}`)) ILLEGAL.push([s, e]);
  }
}

describe("assertWorkflowMappingTransition — legal transitions", () => {
  it.each(LEGAL)("%s + %s -> %s", (from, event, expected) => {
    expect(assertWorkflowMappingTransition(from, event)).toBe(expected);
  });
});

describe("assertWorkflowMappingTransition — illegal transitions throw", () => {
  it.each(ILLEGAL)("%s + %s throws WorkflowTransitionError", (from, event) => {
    expect(() => assertWorkflowMappingTransition(from, event)).toThrow(WorkflowTransitionError);
  });

  it("error carries the offending state, event, and machine id", () => {
    try {
      assertWorkflowMappingTransition("resolved", "RETRY");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowTransitionError);
      const e = err as WorkflowTransitionError;
      expect(e.from).toBe("resolved");
      expect(e.event).toBe("RETRY");
      expect(e.machineId).toBe("workflowMapping");
    }
  });

  it("treats resolved as terminal — no event escapes the final state", () => {
    for (const event of ALL_EVENTS) {
      expect(() => assertWorkflowMappingTransition("resolved", event)).toThrow(
        WorkflowTransitionError,
      );
    }
  });
});

describe("isWorkflowMappingTransitionLegal", () => {
  it.each(LEGAL)("returns true for legal %s + %s", (from, event) => {
    expect(isWorkflowMappingTransitionLegal(from, event)).toBe(true);
  });

  it.each(ILLEGAL)("returns false for illegal %s + %s", (from, event) => {
    expect(isWorkflowMappingTransitionLegal(from, event)).toBe(false);
  });

  it("returns false for an unknown state", () => {
    expect(
      isWorkflowMappingTransitionLegal(
        "nonexistent" as ReceivedReceiptState,
        "PROCEED",
      ),
    ).toBe(false);
  });

  it("returns false for an unknown event from a valid state", () => {
    expect(
      isWorkflowMappingTransitionLegal(
        "pending_review",
        "NOT_AN_EVENT" as WorkflowMappingEventType,
      ),
    ).toBe(false);
  });
});
