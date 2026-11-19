/** The per-run QuickBooks create limit stops at 100; the per-day limit keeps its own ceiling. */
import { describe, expect, it } from "vitest";
import type { Db } from "../../db";
import { DEFAULT_EXPENSE_SETTINGS, ExpenseSettingsPatchSchema, MAX_QB_CREATES, readExpenseSettings } from "../../services/settingsService";

describe("QuickBooks create limits", () => {
  it("accepts a per-run limit of 100 and refuses 101", () => {
    expect(ExpenseSettingsPatchSchema.parse({ qbMaxCreatesPerRun: 100 })).toEqual({ qbMaxCreatesPerRun: 100 });
    expect(() => ExpenseSettingsPatchSchema.parse({ qbMaxCreatesPerRun: 101 })).toThrow();
  });

  it("keeps the per-day limit's ceiling", () => {
    expect(ExpenseSettingsPatchSchema.parse({ qbMaxCreatesPerDay: MAX_QB_CREATES })).toEqual({ qbMaxCreatesPerDay: MAX_QB_CREATES });
    expect(() => ExpenseSettingsPatchSchema.parse({ qbMaxCreatesPerDay: MAX_QB_CREATES + 1 })).toThrow();
  });

  it("reads a stored per-run limit above 100 as 100, and leaves the per-day limit as stored", async () => {
    const stored = { ...DEFAULT_EXPENSE_SETTINGS, qbMaxCreatesPerRun: 1_000, qbMaxCreatesPerDay: 1_000 };
    const client = { expenseOrgSettings: { findUnique: async () => stored } } as unknown as Db;
    await expect(readExpenseSettings(client, "org")).resolves.toEqual({ ...stored, qbMaxCreatesPerRun: 100 });
  });
});
