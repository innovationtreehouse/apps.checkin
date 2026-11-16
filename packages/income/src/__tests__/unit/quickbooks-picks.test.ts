/** System Status's picks row: income items' accounts checked against the app's QuickBooks list. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { configureIncome, incomeRuntime } from "../../runtime";
import { misTypedQuickBooksPicks } from "../../services/quickBooksPicks";
import { db } from "../../db";

vi.mock("../../db", () => ({ db: { incomeItemCategory: { findMany: vi.fn(async () => []) } } }));

const ORG = "00000000-0000-0000-0000-000000000001";
const ACCOUNTS = [
  { id: "4001", name: "Sales:Memberships", accountType: "Income", active: true },
  { id: "1001", name: "Checking", accountType: "Bank", active: true },
];

beforeEach(() => {
  vi.clearAllMocks();
  configureIncome({ auth: { getPrincipal: async () => ({ id: 1, name: "finance" }) }, org: async () => ({ id: ORG, name: "Test Org" }) });
});
afterEach(() => incomeRuntime.reset());

describe("income misTypedQuickBooksPicks", () => {
  it("passes an Income account", async () => {
    vi.mocked(db.incomeItemCategory.findMany).mockResolvedValueOnce([{ variantId: "42", quickBooksAccountId: "4001" }] as never);
    expect(await misTypedQuickBooksPicks(ACCOUNTS)).toEqual([]);
    expect(db.incomeItemCategory.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { orgId: ORG, quickBooksAccountId: { not: null } } }));
  });

  it("flags a missing account and one of the wrong type, naming where to re-pick", async () => {
    vi.mocked(db.incomeItemCategory.findMany).mockResolvedValueOnce([
      { variantId: "42", quickBooksAccountId: "1001" },
      { variantId: "43", quickBooksAccountId: "9999" },
    ] as never);
    expect(await misTypedQuickBooksPicks(ACCOUNTS)).toEqual([
      "Income items, variant 42: An item's account takes an Income or Other Income account; QuickBooks' list in the app shows Checking as Bank",
      "Income items, variant 43: QuickBooks' list in the app doesn't have an account with id 9999",
    ]);
  });
});
