import { describe, expect, it } from "vitest";
import { LINE_ACCOUNT_TYPES, QUICKBOOKS_LIST_STALE, UPDATE_NOW_HINT, accountTypeRefusal, staleListRefusal } from "../accountTypes";

const accounts = [
  { id: "1", name: "Donations:Benevity", accountType: "Income", active: true },
  { id: "2", name: "Checking", accountType: "Bank", active: true },
  { id: "3", name: "Donations:Old drive", accountType: "Income", active: false },
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

  it("refuses an account the app's copy shows as inactive, even of a type the line takes", () => {
    expect(accountTypeRefusal(accounts, "3", LINE_ACCOUNT_TYPES.givingGift, "A gift")).toBe("QuickBooks' list in the app shows Donations:Old drive as inactive");
  });
});

describe("staleListRefusal", () => {
  it("adds the Update now hint to a refusal", () => {
    expect(staleListRefusal(accounts, "9", LINE_ACCOUNT_TYPES.givingGift, "A gift")).toBe(`QuickBooks' list in the app doesn't have an account with id 9. ${UPDATE_NOW_HINT}`);
  });

  it("refuses an inactive account with the hint, under the stale-list code saves send", () => {
    expect(staleListRefusal(accounts, "3", LINE_ACCOUNT_TYPES.givingGift, "A gift")).toBe(`QuickBooks' list in the app shows Donations:Old drive as inactive. ${UPDATE_NOW_HINT}`);
    expect(QUICKBOOKS_LIST_STALE).toBe("quickbooks-list-stale");
  });

  it("accepts what accountTypeRefusal accepts", () => {
    expect(staleListRefusal(accounts, "1", LINE_ACCOUNT_TYPES.givingGift, "A gift")).toBeNull();
  });
});
