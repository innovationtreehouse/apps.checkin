import { describe, expect, it } from "vitest";
import type { AccountMap } from "../../generated/prisma/client";
import { determineAccountsFromMap } from "../../lib/account-map-lookup";
import { depositLines } from "../../lib/deposit-handover";

const rule = (over: Partial<AccountMap> = {}): AccountMap => ({
  id: 1,
  orgId: "org",
  companyName: "*",
  corporatePeerCampaign: "*",
  donationMethod: "check",
  donationType: "standard",
  donationAccount: "",
  matchAccount: "",
  feesAccount: "",
  donationAccountId: "60",
  matchAccountId: "61",
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...over,
});
const gift = { companyName: "Acme", corporatePeerCampaign: "Spring", donationMethod: "check", donationType: "standard", donationAmountCents: 1000, matchAmountCents: 500 };

describe("determineAccountsFromMap", () => {
  it("gives the matched rule", () => {
    expect(determineAccountsFromMap([rule()], gift)).toEqual({ result: rule() });
  });

  it("holds a gift whose rule has no account for an amount the gift carries, naming the rule", () => {
    const noMatchAccount = rule({ matchAccountId: null });
    expect(determineAccountsFromMap([noMatchAccount], gift)).toEqual({ conflict: { reason: "NO_ACCOUNT", matchedRows: [noMatchAccount] } });
    expect(determineAccountsFromMap([rule({ donationAccountId: null })], gift)).toMatchObject({ conflict: { reason: "NO_ACCOUNT" } });
  });

  it("needs no account for an amount the gift does not carry", () => {
    const noMatchAccount = rule({ matchAccountId: null });
    expect(determineAccountsFromMap([noMatchAccount], { ...gift, matchAmountCents: 0 })).toEqual({ result: noMatchAccount });
  });

  it("still holds a gift no rule or several rules match", () => {
    expect(determineAccountsFromMap([], gift)).toMatchObject({ conflict: { reason: "NO_MATCH" } });
    expect(determineAccountsFromMap([rule(), rule({ id: 2 })], gift)).toMatchObject({ conflict: { reason: "MULTIPLE_MATCHES" } });
  });
});

describe("depositLines", () => {
  const bucket = (id: string) => (id === "T2" ? null : 1);

  it("groups lines by kind, account and bucket, each on its rule's account", () => {
    const items = [
      { type: "donation" as const, account: "", accountId: "60", amountCents: 1000, transactionId: "T1" },
      { type: "donation" as const, account: "", accountId: "70", amountCents: 300, transactionId: "T1" },
      { type: "donation" as const, account: "", accountId: "60", amountCents: 200, transactionId: "T3" },
      { type: "match" as const, account: "", accountId: "61", amountCents: 500, transactionId: "T2" },
      { type: "fees" as const, account: "", amountCents: 40, transactionId: "T1" },
    ];
    expect(depositLines(items, bucket)).toEqual([
      { accountId: "60", budgetOwnerId: 1, amountCents: 1200, description: "Benevity donations" },
      { accountId: "70", budgetOwnerId: 1, amountCents: 300, description: "Benevity donations" },
      { accountId: "61", budgetOwnerId: null, amountCents: 500, description: "Benevity matches" },
      { role: "BENEVITY_FEES", budgetOwnerId: 1, amountCents: -40, description: "Benevity fees" },
    ]);
  });

  it("refuses a batch finished before its rules named accounts", () => {
    expect(() => depositLines([{ type: "donation", account: "4000-Donations", amountCents: 1000, transactionId: "T1" }], bucket)).toThrow(
      /finished before its account rules named QuickBooks accounts/,
    );
  });
});
