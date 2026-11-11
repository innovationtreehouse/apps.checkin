import { describe, expect, it } from "vitest";
import type { AccountMapping } from "../../db/schema";
import { donatedPartAccount } from "../../lib/account-rules";

const GTIN = "0012345678905";
const INFO = { gtin13: GTIN, category: "Tools", subcategory: "Lathes" };

let nextId = 1;
const rule = (over: Partial<AccountMapping>): AccountMapping => ({
  id: nextId++,
  orgId: "org-1",
  category: "*",
  subcategory: "*",
  partNumber: "*",
  isDelayed: null,
  isCapital: null,
  qbAccount: "600",
  ...over,
});

describe("donatedPartAccount", () => {
  it("takes the one rule that covers the part", () => {
    expect(donatedPartAccount([rule({ category: "Tools", qbAccount: "610" })], INFO, false)).toEqual({ accountId: "610" });
  });

  it("prefers an exact-GTIN rule over a wider one", () => {
    const rules = [rule({ qbAccount: "600" }), rule({ partNumber: GTIN, qbAccount: "620" })];
    expect(donatedPartAccount(rules, INFO, false)).toEqual({ accountId: "620" });
  });

  it("holds a part no rule covers, and one several rules cover with no exact-GTIN winner", () => {
    expect(donatedPartAccount([rule({ category: "Paper" })], INFO, false)).toEqual({ reason: expect.stringMatching(/No account rule/) });
    expect(donatedPartAccount([rule({}), rule({ category: "Tools" })], INFO, false)).toEqual({ reason: expect.stringMatching(/2 account rules/) });
  });

  it("holds a part the catalog has no category for", () => {
    expect(donatedPartAccount([rule({})], null, false)).toEqual({ reason: expect.stringMatching(/catalog/) });
  });

  it("matches a donated part as not delayed", () => {
    expect(donatedPartAccount([rule({ isDelayed: true })], INFO, false)).toEqual({ reason: expect.stringMatching(/No account rule/) });
    expect(donatedPartAccount([rule({ isDelayed: false, qbAccount: "630" })], INFO, false)).toEqual({ accountId: "630" });
  });

  it("books donated equipment only through a rule marked capital", () => {
    expect(donatedPartAccount([rule({ isCapital: null })], INFO, true)).toEqual({ reason: expect.stringMatching(/marked capital/) });
    expect(donatedPartAccount([rule({ isCapital: null }), rule({ isCapital: true, qbAccount: "150" })], INFO, true)).toEqual({ accountId: "150" });
    expect(donatedPartAccount([rule({ isCapital: true, qbAccount: "150" })], INFO, false)).toEqual({ reason: expect.stringMatching(/No account rule/) });
  });
});
