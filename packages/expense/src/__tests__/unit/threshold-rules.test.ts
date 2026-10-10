/** Which threshold changes are the Board's: the direction each field loosens in, and its policy value. */
import { describe, it, expect } from "vitest";
import { DEFAULT_EXPENSE_SETTINGS, THRESHOLD_RULES, boardOnlyChanges } from "../../services/settingsService";

const current = { ...DEFAULT_EXPENSE_SETTINGS, capitalTotalThresholdCents: 500_000 };

describe("boardOnlyChanges", () => {
  it("declares a direction for every threshold", () => {
    expect(Object.keys(THRESHOLD_RULES).sort()).toEqual(Object.keys(DEFAULT_EXPENSE_SETTINGS).sort());
  });

  it("tightening a policy threshold, or loosening it back up to the policy value, is FINANCE's", () => {
    expect(boardOnlyChanges(current, { boardReviewTotalCents: 100_000 })).toEqual([]);
    expect(boardOnlyChanges({ ...current, boardReviewTotalCents: 100_000 }, { boardReviewTotalCents: 200_000 })).toEqual([]);
  });

  it("loosening a policy threshold past its policy value is the Board's", () => {
    expect(boardOnlyChanges(current, { noteInLieuLimitCents: 5_001, capitalEquipmentUnitCents: 60_000 })).toEqual([
      "noteInLieuLimitCents",
      "capitalEquipmentUnitCents",
    ]);
  });

  it("switching a review threshold off is the Board's; switching it on is FINANCE's", () => {
    expect(boardOnlyChanges(current, { capitalTotalThresholdCents: 0 })).toEqual(["capitalTotalThresholdCents"]);
    expect(boardOnlyChanges(current, { capitalLineItemThresholdCents: 10_000 })).toEqual([]);
  });

  it("between two non-zero review values, lower is FINANCE's and higher is the Board's", () => {
    expect(boardOnlyChanges(current, { capitalTotalThresholdCents: 400_000 })).toEqual([]);
    expect(boardOnlyChanges(current, { capitalTotalThresholdCents: 600_000 })).toEqual(["capitalTotalThresholdCents"]);
  });
});
