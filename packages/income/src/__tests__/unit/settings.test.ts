import { beforeEach, describe, expect, it } from "vitest";
import { configureIncome } from "../../runtime";
import { matchWindow } from "../../lib/reconcile";
import { DEFAULT_INCOME_SETTINGS, settingsChanges } from "../../services/settingsService";

const finance = { userId: 1, isFinance: true, isBoard: false };
const board = { userId: 2, isFinance: false, isBoard: true };

describe("settingsChanges", () => {
  it("lets finance lower a cap and refuses finance a raise", () => {
    expect(settingsChanges(DEFAULT_INCOME_SETTINGS, { maxCreatesPerRun: 10 }, finance)).toEqual({ maxCreatesPerRun: 10 });
    expect(() => settingsChanges(DEFAULT_INCOME_SETTINGS, { maxCreateCentsPerRun: 3_000_000 }, finance)).toThrow(/board/);
  });

  it("lets the board raise a cap", () => {
    expect(settingsChanges(DEFAULT_INCOME_SETTINGS, { maxCreateCentsPerRun: 3_000_000 }, board)).toEqual({ maxCreateCentsPerRun: 3_000_000 });
  });

  it("refuses anyone else, unknown keys and values that are not positive whole numbers", () => {
    expect(() => settingsChanges(DEFAULT_INCOME_SETTINGS, { maxCreatesPerRun: 1 }, { userId: 3, isFinance: false, isBoard: false })).toThrow(/finance or the board/);
    expect(() => settingsChanges(DEFAULT_INCOME_SETTINGS, { other: 1 }, board)).toThrow(/Unknown/);
    for (const bad of [0, -1, 1.5, "5", null]) {
      expect(() => settingsChanges(DEFAULT_INCOME_SETTINGS, { maxCreatesPerRun: bad }, board)).toThrow(/positive whole/);
    }
  });

  it("caps Benevity's cents on their own, under the same lower-only rule", () => {
    expect(settingsChanges(DEFAULT_INCOME_SETTINGS, { benevityMaxCreateCentsPerRun: 1_000 }, finance)).toEqual({ benevityMaxCreateCentsPerRun: 1_000 });
    expect(() => settingsChanges(DEFAULT_INCOME_SETTINGS, { benevityMaxCreateCentsPerRun: 3_000_000 }, finance)).toThrow(/board/);
  });

  it("lets finance move the Benevity window either way, from 1 to 30 days", () => {
    expect(settingsChanges(DEFAULT_INCOME_SETTINGS, { benevityMatchWindowDays: 30 }, finance)).toEqual({ benevityMatchWindowDays: 30 });
    expect(settingsChanges(DEFAULT_INCOME_SETTINGS, { benevityMatchWindowDays: 1 }, finance)).toEqual({ benevityMatchWindowDays: 1 });
    expect(() => settingsChanges(DEFAULT_INCOME_SETTINGS, { benevityMatchWindowDays: 31 }, board)).toThrow(/at most 30/);
    expect(() => settingsChanges(DEFAULT_INCOME_SETTINGS, { benevityMatchWindowDays: 0 }, board)).toThrow(/positive whole/);
  });

  it("drops values equal to the current ones", () => {
    expect(settingsChanges(DEFAULT_INCOME_SETTINGS, { maxCreatesPerRun: 25 }, finance)).toEqual({});
  });
});

describe("matchWindow", () => {
  beforeEach(() => configureIncome({}));

  it("opens 2 days before the payout by default, for QuickBooks dates that run early", () => {
    expect(matchWindow("2026-06-10")).toEqual({ from: "2026-06-08", to: "2026-06-17" });
  });

  it("takes the org's Benevity window on both sides", () => {
    expect(matchWindow("2026-06-10", "benevity", 3)).toEqual({ from: "2026-06-07", to: "2026-06-13" });
  });

  it("takes a configured grace", () => {
    configureIncome({ dateGraceDays: 0 });
    expect(matchWindow("2026-06-10").from).toBe("2026-06-10");
  });
});
