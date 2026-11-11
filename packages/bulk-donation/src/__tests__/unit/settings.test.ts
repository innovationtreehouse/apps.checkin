import { describe, expect, it } from "vitest";
import { DEFAULT_DONATION_SETTINGS as D, settingsChanges } from "../../services/settingsService";

const finance = { isFinance: true, isBoard: false };
const board = { isFinance: false, isBoard: true };

describe("settingsChanges", () => {
  it("lets finance lower the per-run limit and only the board raise it", () => {
    expect(settingsChanges(D, { qbMaxCreatesPerRun: 10 }, finance)).toEqual({ qbMaxCreatesPerRun: 10 });
    expect(() => settingsChanges(D, { qbMaxCreatesPerRun: 60 }, finance)).toThrow(/board/);
    expect(settingsChanges(D, { qbMaxCreatesPerRun: 60 }, board)).toEqual({ qbMaxCreatesPerRun: 60 });
  });

  it("lets finance or the board move the match window either way, from 1 to 30 days", () => {
    expect(settingsChanges(D, { qbMatchWindowDays: 30 }, finance)).toEqual({ qbMatchWindowDays: 30 });
    expect(settingsChanges(D, { qbMatchWindowDays: 1 }, finance)).toEqual({ qbMatchWindowDays: 1 });
    expect(settingsChanges(D, { qbMatchWindowDays: 30 }, board)).toEqual({ qbMatchWindowDays: 30 });
    expect(settingsChanges(D, { qbMatchWindowDays: 1 }, board)).toEqual({ qbMatchWindowDays: 1 });
    expect(() => settingsChanges(D, { qbMatchWindowDays: 31 }, board)).toThrow(/1 to 30/);
  });

  it("refuses anyone else, unknown keys and a per-day limit", () => {
    expect(() => settingsChanges(D, { qbMatchWindowDays: 3 }, { isFinance: false, isBoard: false })).toThrow(/finance or the board/);
    expect(() => settingsChanges(D, { other: 1 }, board)).toThrow(/Unknown/);
    expect(() => settingsChanges(D, { qbMaxCreatesPerDay: 10 }, board)).toThrow(/Unknown/);
  });
});
