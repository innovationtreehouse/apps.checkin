import { describe, expect, it } from "vitest";
import { tallyReceivingStates } from "../../services/stateCounts";

const row = (state: string, n: number) => ({ state, _count: { _all: n } });

describe("receiving state tally", () => {
  it("shows a zero for every state when there are no received receipts", () => {
    expect(tallyReceivingStates([])).toEqual([
      { state: "pending_review", label: "Needs mapping", count: 0 },
      { state: "applying", label: "Applying", count: 0 },
      { state: "apply_failed", label: "Apply failed", count: 0 },
      { state: "resolved", label: "Resolved", count: 0 },
    ]);
  });

  it("counts present states and keeps absent ones at zero", () => {
    const out = tallyReceivingStates([row("applying", 4), row("resolved", 9)]);
    expect(out.map((s) => [s.state, s.count])).toEqual([["pending_review", 0], ["applying", 4], ["apply_failed", 0], ["resolved", 9]]);
  });

  it("appends a stored state the enum does not define, labelled by its code", () => {
    expect(tallyReceivingStates([row("legacy_state", 1)]).at(-1)).toEqual({ state: "legacy_state", label: "legacy_state", count: 1 });
  });
});
