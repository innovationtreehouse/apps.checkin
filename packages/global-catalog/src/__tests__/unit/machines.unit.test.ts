import { describe, it, expect } from "vitest";
import { itemReferenceProposalMachine, assertItemReferenceProposalTransition } from "@/workflows/item-reference-proposal.machine";
import { provisionalProposalMachine, assertProvisionalProposalTransition } from "@/workflows/provisional-proposal.machine";
import { conversionChallengeMachine, assertConversionChallengeTransition } from "@/workflows/conversion-challenge.machine";
import { conflictResolutionMachine, assertConflictResolutionTransition } from "@/workflows/conflict-resolution.machine";
import { WorkflowTransitionError } from '@inventory/workflows';

// Helper: resolve a machine snapshot from a state value string
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function snap(machine: any, value: string) {
  return machine.resolveState({ value });
}

// ── itemReferenceProposalMachine ─────────────────────────────────────────────

describe("itemReferenceProposalMachine", () => {
  describe("pending", () => {
    const s = snap(itemReferenceProposalMachine, "pending");
    it("can APPROVE", () => expect(s.can({ type: "APPROVE" })).toBe(true));
    it("can REJECT", () => expect(s.can({ type: "REJECT" })).toBe(true));
    it("can SUPERSEDE", () => expect(s.can({ type: "SUPERSEDE" })).toBe(true));
  });

  for (const terminal of ["approved", "rejected", "superseded"] as const) {
    describe(`${terminal} (terminal)`, () => {
      const s = snap(itemReferenceProposalMachine, terminal);
      it("cannot APPROVE", () => expect(s.can({ type: "APPROVE" })).toBe(false));
      it("cannot REJECT", () => expect(s.can({ type: "REJECT" })).toBe(false));
      it("cannot SUPERSEDE", () => expect(s.can({ type: "SUPERSEDE" })).toBe(false));
    });
  }
});

// ── provisionalProposalMachine ───────────────────────────────────────────────

describe("provisionalProposalMachine", () => {
  describe("pending", () => {
    const s = snap(provisionalProposalMachine, "pending");
    const sResolved = provisionalProposalMachine.resolveState({ value: "pending", context: { hasCategoryResolved: true, hasSubcategoryResolved: true } });
    it("can APPROVE (with resolved category+subcategory)", () => expect(sResolved.can({ type: "APPROVE" })).toBe(true));
    it("can REJECT", () => expect(s.can({ type: "REJECT" })).toBe(true));
    it("can MAP_TO_EXISTING", () => expect(s.can({ type: "MAP_TO_EXISTING" })).toBe(true));
  });

  for (const terminal of ["approved", "rejected", "mapped_to_existing"] as const) {
    describe(`${terminal} (terminal)`, () => {
      const s = snap(provisionalProposalMachine, terminal);
      it("cannot APPROVE", () => expect(s.can({ type: "APPROVE" })).toBe(false));
      it("cannot REJECT", () => expect(s.can({ type: "REJECT" })).toBe(false));
      it("cannot MAP_TO_EXISTING", () => expect(s.can({ type: "MAP_TO_EXISTING" })).toBe(false));
    });
  }
});

// ── conversionChallengeMachine ───────────────────────────────────────────────

describe("conversionChallengeMachine", () => {
  describe("pending", () => {
    const s = snap(conversionChallengeMachine, "pending");
    it("can ACCEPT", () => expect(s.can({ type: "ACCEPT" })).toBe(true));
    it("can REJECT", () => expect(s.can({ type: "REJECT" })).toBe(true));
  });

  for (const terminal of ["accepted", "rejected"] as const) {
    describe(`${terminal} (terminal)`, () => {
      const s = snap(conversionChallengeMachine, terminal);
      it("cannot ACCEPT", () => expect(s.can({ type: "ACCEPT" })).toBe(false));
      it("cannot REJECT", () => expect(s.can({ type: "REJECT" })).toBe(false));
    });
  }
});

// ── conflictResolutionMachine ────────────────────────────────────────────────

describe("conflictResolutionMachine", () => {
  describe("open", () => {
    const s = snap(conflictResolutionMachine, "open");
    it("can RESOLVE keep_existing", () =>
      expect(s.can({ type: "RESOLVE", resolution: "keep_existing" })).toBe(true));
    it("can RESOLVE use_proposed", () =>
      expect(s.can({ type: "RESOLVE", resolution: "use_proposed" })).toBe(true));
  });

  for (const terminal of ["keep_existing", "use_proposed"] as const) {
    describe(`${terminal} (terminal)`, () => {
      const s = snap(conflictResolutionMachine, terminal);
      it("cannot RESOLVE keep_existing", () =>
        expect(s.can({ type: "RESOLVE", resolution: "keep_existing" })).toBe(false));
      it("cannot RESOLVE use_proposed", () =>
        expect(s.can({ type: "RESOLVE", resolution: "use_proposed" })).toBe(false));
    });
  }
});

// ── assertItemReferenceProposalTransition ────────────────────────────────────

describe("assertItemReferenceProposalTransition", () => {
  it("transitions pending → approved", () => {
    expect(assertItemReferenceProposalTransition("pending", "APPROVE")).toBe("approved");
  });
  it("transitions pending → rejected", () => {
    expect(assertItemReferenceProposalTransition("pending", "REJECT")).toBe("rejected");
  });
  it("transitions pending → superseded", () => {
    expect(assertItemReferenceProposalTransition("pending", "SUPERSEDE")).toBe("superseded");
  });

  for (const terminal of ["approved", "rejected", "superseded"] as const) {
    it(`throws WorkflowTransitionError from terminal state '${terminal}'`, () => {
      expect(() => assertItemReferenceProposalTransition(terminal, "APPROVE")).toThrow(WorkflowTransitionError);
    });
  }
});

// ── assertProvisionalProposalTransition ──────────────────────────────────────

describe("assertProvisionalProposalTransition", () => {
  it("transitions pending → approved", () => {
    expect(assertProvisionalProposalTransition("pending", "APPROVE", { hasCategoryResolved: true, hasSubcategoryResolved: true })).toBe("approved");
  });
  it("transitions pending → rejected", () => {
    expect(assertProvisionalProposalTransition("pending", "REJECT")).toBe("rejected");
  });
  it("transitions pending → mapped_to_existing", () => {
    expect(assertProvisionalProposalTransition("pending", "MAP_TO_EXISTING")).toBe("mapped_to_existing");
  });

  for (const terminal of ["approved", "rejected", "mapped_to_existing"] as const) {
    it(`throws WorkflowTransitionError from terminal state '${terminal}'`, () => {
      expect(() => assertProvisionalProposalTransition(terminal, "APPROVE")).toThrow(WorkflowTransitionError);
    });
  }
});

// ── assertConversionChallengeTransition ──────────────────────────────────────

describe("assertConversionChallengeTransition", () => {
  it("transitions pending → accepted", () => {
    expect(assertConversionChallengeTransition("pending", "ACCEPT")).toBe("accepted");
  });
  it("transitions pending → rejected", () => {
    expect(assertConversionChallengeTransition("pending", "REJECT")).toBe("rejected");
  });

  for (const terminal of ["accepted", "rejected"] as const) {
    it(`throws WorkflowTransitionError from terminal state '${terminal}'`, () => {
      expect(() => assertConversionChallengeTransition(terminal, "ACCEPT")).toThrow(WorkflowTransitionError);
    });
  }
});

// ── assertConflictResolutionTransition ───────────────────────────────────────

describe("assertConflictResolutionTransition", () => {
  it("transitions open → keep_existing", () => {
    expect(assertConflictResolutionTransition("open", { type: "RESOLVE", resolution: "keep_existing" })).toBe("keep_existing");
  });
  it("transitions open → use_proposed", () => {
    expect(assertConflictResolutionTransition("open", { type: "RESOLVE", resolution: "use_proposed" })).toBe("use_proposed");
  });

  for (const terminal of ["keep_existing", "use_proposed"] as const) {
    it(`throws WorkflowTransitionError from terminal state '${terminal}'`, () => {
      expect(() =>
        assertConflictResolutionTransition(terminal, { type: "RESOLVE", resolution: "keep_existing" })
      ).toThrow(WorkflowTransitionError);
    });
  }

  it("error message includes resolution value when no guard matches", () => {
    // Simulate a guard fallthrough by casting an invalid resolution through
    const badEvent = { type: "RESOLVE" as const, resolution: "invalid_value" as "keep_existing" };
    let err: WorkflowTransitionError | undefined;
    try {
      assertConflictResolutionTransition("open", badEvent);
    } catch (e) {
      err = e as WorkflowTransitionError;
    }
    expect(err).toBeInstanceOf(WorkflowTransitionError);
    expect(err?.message).toContain("resolution=invalid_value");
  });
});
