/** An item's account save refuses an account QuickBooks lists under a type a store sale can't book to. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { configureIncome, incomeRuntime } from "../../runtime";
import { setItemCategory } from "../../routes";
import { itemCategoryService } from "../../services/itemCategoryService";

vi.mock("../../services/itemCategoryService", () => ({
  itemCategoryService: { setCategory: vi.fn(async () => ({ variantId: "42" })) },
}));

const ACCOUNTS = [
  { id: "4001", name: "Sales:Memberships", accountType: "Income" },
  { id: "1001", name: "Checking", accountType: "Bank" },
];

const configure = (quickBooksAccounts?: () => Promise<typeof ACCOUNTS>) =>
  configureIncome({
    auth: { getPrincipal: async () => ({ id: 1, name: "finance" }) },
    org: async () => ({ id: "00000000-0000-0000-0000-000000000001", name: "Test Org" }),
    quickBooksAccounts,
  });

const save = (body: unknown) =>
  setItemCategory({ req: new Request("http://test/api/income/items/42/category", { method: "PUT", body: JSON.stringify(body) }), params: { variantId: "42" } });

beforeEach(() => {
  vi.clearAllMocks();
  configure(async () => ACCOUNTS);
});
afterEach(() => incomeRuntime.reset());

describe("item account save", () => {
  it("saves an Income account", async () => {
    await save({ budgetOwnerId: null, quickBooksAccountId: "4001" });
    expect(itemCategoryService.setCategory).toHaveBeenCalled();
  });

  it("refuses an account of another type, naming it", async () => {
    await expect(save({ budgetOwnerId: null, quickBooksAccountId: "1001" })).rejects.toMatchObject({
      status: 400,
      message: "An item's account takes an Income or Other Income account; Checking is Bank",
    });
    expect(itemCategoryService.setCategory).not.toHaveBeenCalled();
  });

  it("refuses an account QuickBooks doesn't list", async () => {
    await expect(save({ budgetOwnerId: null, quickBooksAccountId: "9999" })).rejects.toMatchObject({ status: 400 });
    expect(itemCategoryService.setCategory).not.toHaveBeenCalled();
  });

  it.each([
    ["keeps", { budgetOwnerId: null }],
    ["clears", { budgetOwnerId: null, quickBooksAccountId: null }],
  ])("%s the account without reading QuickBooks", async (_, body) => {
    const read = vi.fn(async () => ACCOUNTS);
    configure(read);
    await save(body);
    expect(read).not.toHaveBeenCalled();
    expect(itemCategoryService.setCategory).toHaveBeenCalled();
  });

  it("answers 503 while QuickBooks isn't bound", async () => {
    configure();
    await expect(save({ budgetOwnerId: null, quickBooksAccountId: "4001" })).rejects.toMatchObject({ status: 503 });
    expect(itemCategoryService.setCategory).not.toHaveBeenCalled();
  });
});
