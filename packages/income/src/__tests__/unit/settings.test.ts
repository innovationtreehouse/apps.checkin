import { afterEach, describe, expect, it } from "vitest";
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

  it("drops values equal to the current ones", () => {
    expect(settingsChanges(DEFAULT_INCOME_SETTINGS, { maxCreatesPerRun: 25 }, finance)).toEqual({});
  });
});

describe("matchWindow", () => {
  afterEach(() => configureIncome({}));

  it("opens 2 days before the payout by default, for QuickBooks dates that run early", () => {
    expect(matchWindow("2026-06-10")).toEqual({ from: "2026-06-08", to: "2026-06-17" });
  });

  it("takes a configured grace", () => {
    configureIncome({ dateGraceDays: 0 });
    expect(matchWindow("2026-06-10").from).toBe("2026-06-10");
  });
});
