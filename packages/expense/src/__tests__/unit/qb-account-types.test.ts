/** Adding or changing an expense QuickBooks account refuses one QuickBooks lists under a type expense lines can't book to. */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { configureExpense } from "../../runtime";
import { createQbAccount, updateQbAccount } from "../../routes/finance";
import { db } from "../../db";

vi.mock("../../db", () => ({ db: { $transaction: vi.fn(async () => ({ id: 1 })), expenseQbAccount: { findFirst: vi.fn(async () => ({ id: 1 })) } } }));

const ORG = "00000000-0000-0000-0000-000000000001";
const ACCOUNTS = [
  { id: "8006", name: "Shop supplies", accountType: "Expense", active: true },
  { id: "8001", name: "Checking", accountType: "Bank", active: true },
  { id: "8009", name: "Equipment", accountType: "Fixed Asset", active: true },
];
const finance = { id: 3, name: "finance", isFinance: true, isBoard: false };

const body = (qbAccount: string) =>
  new Request("http://test/qb-accounts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Account", qbAccount }) });

beforeEach(() => {
  vi.clearAllMocks();
  configureExpense({ org: async () => ({ id: ORG, name: "Org One" }), quickbooks: { accounts: async () => ACCOUNTS } });
});

describe("expense QuickBooks account save", () => {
  it("adds an Expense account", async () => {
    await createQbAccount({ req: body("8006"), params: {}, principal: finance });
    expect(db.$transaction).toHaveBeenCalled();
  });

  it("adds a Fixed Asset account, for capital rules", async () => {
    await createQbAccount({ req: body("8009"), params: {}, principal: finance });
    expect(db.$transaction).toHaveBeenCalled();
  });

  it("refuses an account of another type, naming it", async () => {
    await expect(createQbAccount({ req: body("8001"), params: {}, principal: finance })).rejects.toMatchObject({
      status: 400,
      message: "An expense account takes an Expense, Other Expense, Cost of Goods Sold, or Fixed Asset account; Checking is Bank",
    });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("refuses on change too", async () => {
    await expect(updateQbAccount({ req: body("8001"), params: { id: "1" }, principal: finance })).rejects.toMatchObject({ status: 400 });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("renames an account without reading QuickBooks", async () => {
    vi.mocked(db.expenseQbAccount.findFirst).mockResolvedValueOnce({ id: 1, qbAccount: "8006" } as never);
    configureExpense({ org: async () => ({ id: ORG, name: "Org One" }) });
    await updateQbAccount({ req: body("8006"), params: { id: "1" }, principal: finance });
    expect(db.$transaction).toHaveBeenCalled();
  });

  it("answers 503 while QuickBooks isn't bound", async () => {
    configureExpense({ org: async () => ({ id: ORG, name: "Org One" }) });
    await expect(createQbAccount({ req: body("8006"), params: {}, principal: finance })).rejects.toMatchObject({ status: 503 });
  });
});
