import { describe, expect, it } from "vitest";
import { fileDeleteAfter } from "../../services/retention";

const finalized = (receiptDate: string | null, approvedAt: Date | null = null, endedAt: Date | null = null) =>
  fileDeleteAfter({ state: "receipt_finalized", receiptDate, approvedAt, endedAt });

describe("fileDeleteAfter", () => {
  it("keeps an approved receipt through November 15, seven years after its fiscal year's Form 990 deadline", () => {
    const after = new Date("2033-11-16T00:00:00Z");
    expect(finalized("2025-07-01")).toEqual(after);
    expect(finalized("2026-06-30")).toEqual(after);
    expect(finalized("2026-07-01")).toEqual(new Date("2034-11-16T00:00:00Z"));
  });

  it("dates an approved receipt with no receipt date by its approval, else by its finalizing", () => {
    expect(finalized(null, new Date("2026-08-01T12:00:00Z"), new Date("2025-01-01T00:00:00Z"))).toEqual(new Date("2034-11-16T00:00:00Z"));
    expect(finalized(null, null, new Date("2026-03-01T12:00:00Z"))).toEqual(new Date("2033-11-16T00:00:00Z"));
    expect(finalized(null)).toBeNull();
  });

  it("keeps a rejected or discarded receipt one year past that decision, and an undated one forever", () => {
    const at = new Date("2026-02-03T04:05:06Z");
    expect(fileDeleteAfter({ state: "rejected", receiptDate: "2020-01-01", approvedAt: null, endedAt: at })).toEqual(new Date("2027-02-03T04:05:06Z"));
    expect(fileDeleteAfter({ state: "discarded", receiptDate: null, approvedAt: null, endedAt: at })).toEqual(new Date("2027-02-03T04:05:06Z"));
    expect(fileDeleteAfter({ state: "rejected", receiptDate: null, approvedAt: null, endedAt: null })).toBeNull();
  });

  it("never deletes a receipt still waiting on a decision", () => {
    for (const state of ["uploaded", "submitter_review", "financial_review", "flow_error"]) {
      expect(fileDeleteAfter({ state, receiptDate: "2000-01-01", approvedAt: null, endedAt: new Date(0) })).toBeNull();
    }
  });
});
