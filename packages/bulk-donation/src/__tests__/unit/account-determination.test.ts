import { describe, expect, it } from "vitest";
import type { AccountMap } from "../../generated/prisma/client";
import { determineAccountsFromMap } from "../../lib/account-map-lookup";
import { depositLines } from "../../lib/deposit-handover";
import { giftItems } from "../../lib/disbursement-processor";

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
const gift = { companyName: "Acme", corporatePeerCampaign: "Spring", donationMethod: "check", donationType: "standard", donationAmountCents: 1000, matchAmountCents: 500, feeCents: 0 };

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

  it("holds a row with fees and no amount, whatever the rules say", () => {
    const feesOnly = { ...gift, donationAmountCents: 0, matchAmountCents: 0, feeCents: 250 };
    expect(determineAccountsFromMap([rule()], feesOnly)).toEqual({ conflict: { reason: "FEES_ONLY", matchedRows: [] } });
    expect(determineAccountsFromMap([], feesOnly)).toMatchObject({ conflict: { reason: "FEES_ONLY" } });
  });

  it("still holds a gift no rule or several rules match", () => {
    expect(determineAccountsFromMap([], gift)).toMatchObject({ conflict: { reason: "NO_MATCH" } });
    expect(determineAccountsFromMap([rule(), rule({ id: 2 })], gift)).toMatchObject({ conflict: { reason: "MULTIPLE_MATCHES" } });
  });
});

describe("giftItems", () => {
  const row = (donationAmountCents: number, matchAmountCents: number, fees: [number, number, number] = [250, 0, 0]) => ({
    transactionId: "T1",
    donationAmountCents,
    matchAmountCents,
    causeSupportFeeCents: fees[0],
    merchantFeeCents: fees[1],
    checkFeeCents: fees[2],
  });
  const net = (tx: ReturnType<typeof row>) => giftItems(tx, rule()).map((i) => [i.type, i.amountCents]);

  it.each([
    [10000, 10000, [["donation", 9875], ["match", 9875]]],
    [10000, 5000, [["donation", 9833], ["match", 4917]]],
    [500, 9500, [["donation", 488], ["match", 9262]]],
    [4000, 0, [["donation", 3750]]],
    [1, 2, [["donation", -82], ["match", -165]]],
  ])("nets a $2.50 fee into donation %i and match %i in proportion", (donation, match, expected) => {
    expect(net(row(donation, match))).toEqual(expected);
  });

  it("sums the three fee columns before splitting", () => {
    expect(net(row(10000, 10000, [100, 100, 50]))).toEqual([["donation", 9875], ["match", 9875]]);
  });

  it("puts each item on its rule's account and makes no fee item", () => {
    expect(giftItems(row(10000, 5000), rule())).toEqual([
      { type: "donation", account: "", accountId: "60", amountCents: 9833, transactionId: "T1" },
      { type: "match", account: "", accountId: "61", amountCents: 4917, transactionId: "T1" },
    ]);
  });

  it("makes nothing from a row with no amount and no fee", () => {
    expect(giftItems(row(0, 0, [0, 0, 0]), rule())).toEqual([]);
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
    ];
    expect(depositLines(items, bucket)).toEqual([
      { accountId: "60", budgetOwnerId: 1, amountCents: 1200, description: "Benevity donations" },
      { accountId: "70", budgetOwnerId: 1, amountCents: 300, description: "Benevity donations" },
      { accountId: "61", budgetOwnerId: null, amountCents: 500, description: "Benevity matches" },
    ]);
  });

  it("refuses a batch finished before fees reduced income", () => {
    const items = [
      { type: "donation" as const, account: "", accountId: "60", amountCents: 1000, transactionId: "T1" },
      { type: "fees" as const, account: "6000-Fees", amountCents: 40, transactionId: "T1" },
    ];
    expect(() => depositLines(items, bucket)).toThrow(/finished before fees came out of income/);
  });

  it("refuses a batch finished before its rules named accounts", () => {
    expect(() => depositLines([{ type: "donation", account: "4000-Donations", amountCents: 1000, transactionId: "T1" }], bucket)).toThrow(
      /finished before its account rules named QuickBooks accounts/,
    );
  });
});
