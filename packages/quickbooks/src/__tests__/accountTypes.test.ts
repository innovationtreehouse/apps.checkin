import { describe, expect, it } from "vitest";
import { LINE_ACCOUNT_TYPES, accountTypeRefusal } from "../accountTypes";

const accounts = [
  { id: "1", name: "Donations:Benevity", accountType: "Income" },
  { id: "2", name: "Checking", accountType: "Bank" },
];

describe("accountTypeRefusal", () => {
  it("accepts an account of a type the line takes", () => {
    expect(accountTypeRefusal(accounts, "1", LINE_ACCOUNT_TYPES.givingGift, "A gift")).toBeNull();
  });

  it("names the types the line takes and the account's own", () => {
    expect(accountTypeRefusal(accounts, "2", LINE_ACCOUNT_TYPES.givingGift, "A gift")).toBe(
      "A gift takes an Income or Other Income account; Checking is Bank",
    );
  });

  it("refuses an id QuickBooks doesn't list", () => {
    expect(accountTypeRefusal(accounts, "9", LINE_ACCOUNT_TYPES.givingGift, "A gift")).toBe("QuickBooks has no account with id 9");
  });
});
