/**
 * #4 (part 1) — Workflow state machine and its invariants.
 *
 * Every state mutation in the app is gated by these invariants
 * (assertLegalTransition / assertExpectedState). Tests cover both legal branches
 * (guards routing to the right next state) and illegal transitions that MUST
 * throw, which is what prevents an expense from skipping or repeating a stage.
 */
import { describe, it, expect } from "vitest";
import { createActor } from "xstate";
import { expenseMachine } from "../../workflows/expense.machine";
import {
  assertLegalTransition,
  assertExpectedState,
  isLegalTransition,
  legalEventTypes,
  isTerminalState,
} from "../../workflows/expense.invariants";

/** Drive the machine from `initial` through a sequence of events; return state. */
function run(events: Parameters<typeof expenseMachine.transition>[1][]): string {
  const actor = createActor(expenseMachine).start();
  for (const e of events) actor.send(e);
  const value = actor.getSnapshot().value;
  actor.stop();
  return String(value);
}

describe("expense machine — guard-driven branching", () => {
  it("routes resolved owners straight to owner_approval", () => {
    expect(run([{ type: "FLOW_STARTED", allOwnersResolved: true }])).toBe("owner_approval");
  });

  it("routes unresolved owners to assign_ownership", () => {
    expect(run([{ type: "FLOW_STARTED", allOwnersResolved: false }])).toBe("assign_ownership");
  });

  it("routes capital expenses into capital_review after approval", () => {
    expect(
      run([
        { type: "FLOW_STARTED", allOwnersResolved: true },
        { type: "ALL_APPROVALS_TERMINAL", hasCapital: true, anyRejected: false },
      ]),
    ).toBe("capital_review");
  });

  it("skips capital_review straight to qb_pending when no capital", () => {
    expect(
      run([
        { type: "FLOW_STARTED", allOwnersResolved: true },
        { type: "ALL_APPROVALS_TERMINAL", hasCapital: false, anyRejected: false },
      ]),
    ).toBe("qb_pending");
  });

  it("routes to the rejected terminal state when any approval is rejected", () => {
    expect(
      run([
        { type: "FLOW_STARTED", allOwnersResolved: true },
        { type: "ALL_APPROVALS_TERMINAL", hasCapital: false, anyRejected: true },
      ]),
    ).toBe("rejected");
  });

  it("anyRejected wins over hasCapital — a rejected line refuses the whole expense", () => {
    expect(
      run([
        { type: "FLOW_STARTED", allOwnersResolved: true },
        { type: "ALL_APPROVALS_TERMINAL", hasCapital: true, anyRejected: true },
      ]),
    ).toBe("rejected");
  });

  it("requires depreciation only when capital items remain", () => {
    expect(
      run([
        { type: "FLOW_STARTED", allOwnersResolved: true },
        { type: "ALL_APPROVALS_TERMINAL", hasCapital: true, anyRejected: false },
        { type: "CAPITAL_REVIEW_SUBMITTED", hasCapitalItems: true },
      ]),
    ).toBe("set_depreciation_cycle");
  });

  it("reaches the terminal qb_complete via the full happy path", () => {
    expect(
      run([
        { type: "FLOW_STARTED", allOwnersResolved: true },
        { type: "ALL_APPROVALS_TERMINAL", hasCapital: true, anyRejected: false },
        { type: "CAPITAL_REVIEW_SUBMITTED", hasCapitalItems: true },
        { type: "DEPRECIATION_SET" },
        { type: "QB_COMPLETE" },
      ]),
    ).toBe("qb_complete");
  });

  it("models the hold/resolve loop in QB processing", () => {
    expect(
      run([
        { type: "FLOW_STARTED", allOwnersResolved: true },
        { type: "ALL_APPROVALS_TERMINAL", hasCapital: false, anyRejected: false },
        { type: "HOLDS_CREATED" },
      ]),
    ).toBe("qb_on_hold");
    expect(
      run([
        { type: "FLOW_STARTED", allOwnersResolved: true },
        { type: "ALL_APPROVALS_TERMINAL", hasCapital: false, anyRejected: false },
        { type: "HOLDS_CREATED" },
        { type: "HOLDS_RESOLVED" },
      ]),
    ).toBe("qb_pending");
  });
});

describe("invariants — legal vs illegal transitions", () => {
  it("accepts a legal transition", () => {
    expect(() =>
      assertLegalTransition("pending", { type: "FLOW_STARTED", allOwnersResolved: true }),
    ).not.toThrow();
  });

  it("throws on an event the current state does not accept", () => {
    expect(() =>
      assertLegalTransition("pending", { type: "QB_COMPLETE" }),
    ).toThrow();
  });

  it("throws when the resulting state is not the expected one", () => {
    expect(() =>
      assertExpectedState(
        "pending",
        { type: "FLOW_STARTED", allOwnersResolved: false },
        { hasCapital: false },
        "owner_approval", // actually routes to assign_ownership
      ),
    ).toThrow();
  });

  it("reports legal event types per state", () => {
    expect(isLegalTransition("qb_pending", "QB_ERROR")).toBe(true);
    expect(isLegalTransition("qb_pending", "FLOW_STARTED")).toBe(false);
    expect(legalEventTypes("owner_approval")).toContain("ALL_APPROVALS_TERMINAL");
  });

  it("recognizes the terminal state", () => {
    expect(isTerminalState("qb_complete")).toBe(true);
    expect(isTerminalState("rejected")).toBe(true);
    expect(isTerminalState("qb_pending")).toBe(false);
  });
});
