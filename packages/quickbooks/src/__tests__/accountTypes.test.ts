import { describe, expect, it } from "vitest";
import { LINE_ACCOUNT_TYPES, UPDATE_NOW_HINT, accountTypeRefusal, staleListRefusal } from "../accountTypes";

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
      "A gift takes an Income or Other Income account; QuickBooks' list in the app shows Checking as Bank",
    );
  });

  it("refuses an id the app's copy doesn't list", () => {
    expect(accountTypeRefusal(accounts, "9", LINE_ACCOUNT_TYPES.givingGift, "A gift")).toBe("QuickBooks' list in the app doesn't have an account with id 9");
  });
});

describe("staleListRefusal", () => {
  it("adds the Update now hint to a refusal", () => {
    expect(staleListRefusal(accounts, "9", LINE_ACCOUNT_TYPES.givingGift, "A gift")).toBe(`QuickBooks' list in the app doesn't have an account with id 9. ${UPDATE_NOW_HINT}`);
  });

  it("accepts what accountTypeRefusal accepts", () => {
    expect(staleListRefusal(accounts, "1", LINE_ACCOUNT_TYPES.givingGift, "A gift")).toBeNull();
  });
});
