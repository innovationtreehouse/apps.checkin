import { describe, expect, it } from "vitest";
import {
  assertProvisionalTransition,
  assertMergeConflictTransition,
  assertReceivedOrgEventTransition,
  WorkflowTransitionError,
} from "@/workflows/index";

// ── ProvisionalItem machine ──────────────────────────────────────────────────

describe("assertProvisionalTransition", () => {
  it("pending → approved via APPROVE", () => {
    expect(assertProvisionalTransition("pending", "APPROVE")).toBe("approved");
  });

  it("pending → rejected via REJECT", () => {
    expect(assertProvisionalTransition("pending", "REJECT")).toBe("rejected");
  });

  it("pending → mapped_to_existing via MAP_TO_EXISTING", () => {
    expect(assertProvisionalTransition("pending", "MAP_TO_EXISTING")).toBe("mapped_to_existing");
  });

  it("throws WorkflowTransitionError for approved → APPROVE (already final)", () => {
    expect(() => assertProvisionalTransition("approved", "APPROVE")).toThrow(WorkflowTransitionError);
  });

  it("throws WorkflowTransitionError for rejected → REJECT (already final)", () => {
    expect(() => assertProvisionalTransition("rejected", "REJECT")).toThrow(WorkflowTransitionError);
  });

  it("throws WorkflowTransitionError for rejected → APPROVE (no back-transition)", () => {
    expect(() => assertProvisionalTransition("rejected", "APPROVE")).toThrow(WorkflowTransitionError);
  });

  it("throws WorkflowTransitionError for mapped_to_existing → REJECT", () => {
    expect(() => assertProvisionalTransition("mapped_to_existing", "REJECT")).toThrow(WorkflowTransitionError);
  });
});

// ── MergeConflict machine ────────────────────────────────────────────────────

describe("assertMergeConflictTransition", () => {
  it("pending → resolved via RESOLVE", () => {
    expect(assertMergeConflictTransition("pending", "RESOLVE")).toBe("resolved");
  });

  it("throws WorkflowTransitionError for resolved → RESOLVE (already final)", () => {
    expect(() => assertMergeConflictTransition("resolved", "RESOLVE")).toThrow(WorkflowTransitionError);
  });
});

// ── ReceivedOrgEvent machine ─────────────────────────────────────────────────

describe("assertReceivedOrgEventTransition", () => {
  it("pending → processed via PROCESS_SUCCESS", () => {
    expect(assertReceivedOrgEventTransition("pending", "PROCESS_SUCCESS")).toBe("processed");
  });

  it("pending → failed via PROCESS_FAIL", () => {
    expect(assertReceivedOrgEventTransition("pending", "PROCESS_FAIL")).toBe("failed");
  });

  it("failed → processed via PROCESS_SUCCESS (retry succeeds)", () => {
    expect(assertReceivedOrgEventTransition("failed", "PROCESS_SUCCESS")).toBe("processed");
  });

  it("throws WorkflowTransitionError for processed → PROCESS_SUCCESS (already final)", () => {
    expect(() => assertReceivedOrgEventTransition("processed", "PROCESS_SUCCESS")).toThrow(WorkflowTransitionError);
  });

  it("throws WorkflowTransitionError for processed → PROCESS_FAIL (already final)", () => {
    expect(() => assertReceivedOrgEventTransition("processed", "PROCESS_FAIL")).toThrow(WorkflowTransitionError);
  });

  it("throws WorkflowTransitionError for failed → PROCESS_FAIL (re-failure not a machine transition)", () => {
    expect(() => assertReceivedOrgEventTransition("failed", "PROCESS_FAIL")).toThrow(WorkflowTransitionError);
  });
});
