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
    expect(boardOnlyChanges(current, { boardReviewTotalCents: 200_001, capitalEquipmentUnitCents: 60_000 })).toEqual([
      "boardReviewTotalCents",
      "capitalEquipmentUnitCents",
    ]);
  });

  it.each(["capitalTotalThresholdCents", "capitalLineItemThresholdCents"] as const)(
    "%s: raising it is the Board's; lowering it, to 0 included, is FINANCE's",
    (field) => {
      const at = { ...DEFAULT_EXPENSE_SETTINGS, [field]: 500_000 };
      expect(boardOnlyChanges(at, { [field]: 600_000 })).toEqual([field]);
      expect(boardOnlyChanges({ ...at, [field]: 0 }, { [field]: 10_000 })).toEqual([field]);
      expect(boardOnlyChanges(at, { [field]: 400_000 })).toEqual([]);
      expect(boardOnlyChanges(at, { [field]: 0 })).toEqual([]);
    },
  );

  it("any change to an Everyday limit is the Board's, lowering included; resending the saved value is not a change", () => {
    expect(boardOnlyChanges(current, { everydayTotalLimitCents: 40_000, everydayItemLimitCents: 30_000 })).toEqual([
      "everydayTotalLimitCents",
      "everydayItemLimitCents",
    ]);
    expect(boardOnlyChanges(current, { everydayTotalLimitCents: 50_000, everydayItemLimitCents: 25_000 })).toEqual([]);
  });
});
