/** System Status's picks row: expense's stored accounts checked against the app's QuickBooks list. */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { configureExpense } from "../../runtime";
import { misTypedQuickBooksPicks } from "../../services/quickBooksPicks";
import { db } from "../../db";

vi.mock("../../db", () => ({
  db: {
    expenseQbAccount: { findMany: vi.fn(async () => []) },
    accountMapping: { findMany: vi.fn(async () => []) },
    expenseLineItem: { findMany: vi.fn(async () => []) },
  },
}));

const ORG = "00000000-0000-0000-0000-000000000001";
const ACCOUNTS = [
  { id: "8006", name: "Shop supplies", accountType: "Expense", active: true },
  { id: "8001", name: "Checking", accountType: "Bank", active: true },
  { id: "8009", name: "Equipment", accountType: "Fixed Asset", active: true },
];
const rule = (qbAccount: string, isCapital: boolean | null) => ({ category: "Tools", subcategory: "Hand", partNumber: "", isCapital, qbAccount });

beforeEach(() => {
  vi.clearAllMocks();
  configureExpense({ org: async () => ({ id: ORG, name: "Org One" }) });
});

describe("expense misTypedQuickBooksPicks", () => {
  it("passes picks of an accepted type", async () => {
    vi.mocked(db.expenseQbAccount.findMany).mockResolvedValueOnce([{ name: "Supplies", qbAccount: "8006" }] as never);
    vi.mocked(db.accountMapping.findMany).mockResolvedValueOnce([rule("8006", false), rule("8009", true)] as never);
    vi.mocked(db.expenseLineItem.findMany).mockResolvedValueOnce([{ expenseId: "e1", lineNumber: 1, isCapital: true, manualQbAccount: "8009" }] as never);
    expect(await misTypedQuickBooksPicks(ACCOUNTS)).toEqual([]);
  });

  it("flags a missing pick and a pick of the wrong type, naming where to re-pick", async () => {
    vi.mocked(db.expenseQbAccount.findMany).mockResolvedValueOnce([{ name: "Gone", qbAccount: "9999" }] as never);
    vi.mocked(db.accountMapping.findMany).mockResolvedValueOnce([rule("8009", false)] as never);
    vi.mocked(db.expenseLineItem.findMany).mockResolvedValueOnce([{ expenseId: "e1", lineNumber: 2, isCapital: false, manualQbAccount: "8001" }] as never);
    expect(await misTypedQuickBooksPicks(ACCOUNTS)).toEqual([
      "Expense accounts, Gone: QuickBooks' list in the app doesn't have an account with id 9999",
      "Expense account rules, Tools / Hand: A rule's account takes an Expense, Other Expense, or Cost of Goods Sold account; QuickBooks' list in the app shows Equipment as Fixed Asset",
      "Expense e1, held line 2: A line's account takes an Expense, Other Expense, or Cost of Goods Sold account; QuickBooks' list in the app shows Checking as Bank",
    ]);
  });

  it("checks a capital rule against Fixed Asset", async () => {
    vi.mocked(db.accountMapping.findMany).mockResolvedValueOnce([rule("8006", true)] as never);
    expect(await misTypedQuickBooksPicks(ACCOUNTS)).toEqual([
      "Expense account rules, Tools / Hand: A capital rule's account takes a Fixed Asset account; QuickBooks' list in the app shows Shop supplies as Expense",
    ]);
  });

  it("reads only held lines on expenses not yet booked, in this org", async () => {
    await misTypedQuickBooksPicks(ACCOUNTS);
    expect(db.expenseLineItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { manualQbAccount: { not: null }, expense: { orgId: ORG, qbMatchState: { notIn: ["POSTING", "CREATED", "MATCHED"] } } } }),
    );
  });
});
