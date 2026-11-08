/** An account rule and a held line's account take Fixed Asset when capital, else an expense type; QuickBooks is read live. */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { configureExpense } from "../../runtime";
import { createAccountMapping, holdLineAccount, updateAccountMapping } from "../../routes/finance";
import { db } from "../../db";

vi.mock("../../db", () => ({
  db: {
    $transaction: vi.fn(async () => ({ id: 1 })),
    accountMapping: { findFirst: vi.fn(async () => ({ id: 1, partNumber: "*" })) },
    expenseLineItem: { findFirst: vi.fn(async () => ({ id: 3, manualQbAccount: null, isCapital: false })) },
  },
}));

const ORG = "00000000-0000-0000-0000-000000000001";
const ACCOUNTS = [
  { id: "8006", name: "Shop supplies", accountType: "Expense", active: true },
  { id: "8009", name: "Equipment", accountType: "Fixed Asset", active: true },
];
const finance = { id: 3, name: "finance", isFinance: true, isBoard: false };

const req = (body: unknown) => new Request("http://test/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const rule = (qbAccount: string, isCapital: boolean | null) => req({ category: "*", subcategory: "*", partNumber: "*", isDelayed: null, isCapital, qbAccount });
const heldLine = (isCapital: boolean) => vi.mocked(db.expenseLineItem.findFirst).mockResolvedValueOnce({ id: 3, manualQbAccount: null, isCapital } as never);

beforeEach(() => {
  vi.clearAllMocks();
  configureExpense({ org: async () => ({ id: ORG, name: "Org One" }), quickbooks: { accounts: async () => ACCOUNTS } });
});

describe("account rule save", () => {
  it.each([[null], [false]])("saves an Expense account on a rule with isCapital %s", async (isCapital) => {
    await createAccountMapping({ req: rule("8006", isCapital), params: {}, principal: finance });
    expect(db.$transaction).toHaveBeenCalled();
  });

  it("saves a Fixed Asset account on a capital rule", async () => {
    await createAccountMapping({ req: rule("8009", true), params: {}, principal: finance });
    expect(db.$transaction).toHaveBeenCalled();
  });

  it("refuses a Fixed Asset account on a rule that doesn't say it's capital", async () => {
    await expect(createAccountMapping({ req: rule("8009", null), params: {}, principal: finance })).rejects.toMatchObject({
      status: 400,
      message: "A rule's account takes an Expense, Other Expense, or Cost of Goods Sold account; Equipment is Fixed Asset",
    });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("refuses an expense account on a capital rule, on change too", async () => {
    await expect(updateAccountMapping({ req: rule("8006", true), params: { id: "1" }, principal: finance })).rejects.toMatchObject({
      status: 400,
      message: "A capital rule's account takes a Fixed Asset account; Shop supplies is Expense",
    });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("answers 503 while QuickBooks isn't bound", async () => {
    configureExpense({ org: async () => ({ id: ORG, name: "Org One" }) });
    await expect(createAccountMapping({ req: rule("8006", null), params: {}, principal: finance })).rejects.toMatchObject({ status: 503 });
  });
});

describe("held line account save", () => {
  const put = (qbAccount: string) => holdLineAccount({ req: req({ qbAccount }), params: { expenseId: "e1", lineItemId: "3" }, principal: finance });

  it("sets an Expense account on a line that isn't capital", async () => {
    heldLine(false);
    await put("8006");
    expect(db.$transaction).toHaveBeenCalled();
  });

  it("refuses a Fixed Asset account on a line that isn't capital", async () => {
    heldLine(false);
    await expect(put("8009")).rejects.toMatchObject({ status: 400, message: "A line's account takes an Expense, Other Expense, or Cost of Goods Sold account; Equipment is Fixed Asset" });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("takes only a Fixed Asset account on a capital line", async () => {
    heldLine(true);
    await expect(put("8006")).rejects.toMatchObject({ status: 400, message: "A capital line's account takes a Fixed Asset account; Shop supplies is Expense" });
    heldLine(true);
    await put("8009");
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });

  it("answers 503 while QuickBooks isn't bound", async () => {
    configureExpense({ org: async () => ({ id: ORG, name: "Org One" }) });
    heldLine(false);
    await expect(put("8006")).rejects.toMatchObject({ status: 503 });
  });
});
