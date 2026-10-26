import { describe, expect, it } from "vitest";
import { billCandidate, depositCandidate, findMatch, purchaseCandidate, type MatchRequest } from "../match";
import { appKeyOf } from "../client";
import type { QboBill, QboDeposit, QboPurchase } from "../types";

// Recorded-shape QBO fixtures (trimmed to the fields matching reads).
const deposit = (Id: string, TxnDate: string, TotalAmt: number, extra: Partial<QboDeposit> = {}): QboDeposit => ({
  Id,
  TxnDate,
  TotalAmt,
  DepositToAccountRef: { value: "35", name: "Checking" },
  ...extra,
});

const keyInNote = (d: QboDeposit) => /^app:(\S+)$/.exec(d.PrivateNote ?? "")?.[1];

const base: MatchRequest = {
  date: "2025-03-03",
  amountCents: 123_45,
  ref: "35",
  key: "gid://shopify/Payout/1",
  window: { from: "2025-03-03", to: "2025-03-10" },
  claimedIds: new Set(),
  excludedIds: new Set(),
};

const run = (deposits: QboDeposit[], req: Partial<MatchRequest> = {}) =>
  findMatch(
    deposits.map((d) => depositCandidate(d, keyInNote)),
    { ...base, ...req },
  );

describe("findMatch", () => {
  it("finds a single hand entry on net amount + date in window", () => {
    expect(run([deposit("10", "2025-03-05", 123.45), deposit("11", "2025-03-05", 99)])).toEqual({
      kind: "found",
      id: "10",
      via: "amount",
    });
  });

  it("ignores entries outside the window, on another account, or for another amount", () => {
    const misses = [
      deposit("1", "2025-03-02", 123.45),
      deposit("2", "2025-03-11", 123.45),
      deposit("3", "2025-03-05", 123.45, { DepositToAccountRef: { value: "36" } }),
      deposit("4", "2025-03-05", 123.44),
    ];
    expect(run(misses)).toEqual({ kind: "not-found" });
  });

  it("sends more than one candidate to a person", () => {
    expect(run([deposit("10", "2025-03-04", 123.45), deposit("12", "2025-03-09", 123.45)])).toEqual({
      kind: "ambiguous",
      ids: ["10", "12"],
    });
  });

  it("skips excluded and already-claimed entries", () => {
    const rows = [deposit("10", "2025-03-04", 123.45), deposit("12", "2025-03-09", 123.45)];
    expect(run(rows, { excludedIds: new Set(["10"]) })).toEqual({ kind: "found", id: "12", via: "amount" });
    expect(run(rows, { claimedIds: new Set(["12"]) })).toEqual({ kind: "found", id: "10", via: "amount" });
    expect(run(rows, { excludedIds: new Set(["10"]), claimedIds: new Set(["12"]) })).toEqual({ kind: "not-found" });
  });

  it("finds the app's own creation by the caller's key, ahead of a hand entry of the same amount", () => {
    const own = deposit("20", "2025-03-04", 123.45, { PrivateNote: "app:gid://shopify/Payout/1" });
    const hand = deposit("21", "2025-03-04", 123.45);
    expect(run([own, hand])).toEqual({ kind: "found", id: "20", via: "key" });
  });

  it("finds the app's own creation under an older key the caller names, and never by amount", () => {
    const legacy = deposit("22", "2025-03-04", 123.45, { PrivateNote: "app:donation:org:d1" });
    expect(run([legacy], { alsoKeys: ["donation:org:d1"] })).toEqual({ kind: "found", id: "22", via: "key" });
    expect(run([legacy])).toEqual({ kind: "ambiguous", ids: ["22"] });
  });

  it("finds a key hit dated a day or two off, as long as it is inside the window", () => {
    const own = deposit("20", "2025-03-01", 123.45, { PrivateNote: "app:gid://shopify/Payout/1" });
    expect(run([own], { date: "2025-03-03", window: { from: "2025-03-01", to: "2025-03-10" } })).toEqual({
      kind: "found",
      id: "20",
      via: "key",
    });
  });

  it.each([
    ["for another amount", deposit("20", "2025-03-04", 1, { PrivateNote: "app:gid://shopify/Payout/1" })],
    ["on another account", deposit("20", "2025-03-04", 123.45, { PrivateNote: "app:gid://shopify/Payout/1", DepositToAccountRef: { value: "36" } })],
    ["dated before the window", deposit("20", "2025-03-02", 123.45, { PrivateNote: "app:gid://shopify/Payout/1" })],
    ["dated after the window", deposit("20", "2025-03-11", 123.45, { PrivateNote: "app:gid://shopify/Payout/1" })],
  ])("sends a key hit %s to a person, never found and never not-found", (_, own) => {
    const hand = deposit("21", "2025-03-04", 123.45);
    expect(run([own])).toEqual({ kind: "ambiguous", ids: ["20"] });
    expect(run([own, hand])).toEqual({ kind: "ambiguous", ids: ["20"] });
  });

  it("sends a matching entry carrying another record's key to a person (a copied memo)", () => {
    const other = deposit("22", "2025-03-04", 123.45, { PrivateNote: "app:gid://shopify/Payout/2" });
    const hand = deposit("21", "2025-03-05", 123.45);
    expect(run([other])).toEqual({ kind: "ambiguous", ids: ["22"] });
    expect(run([hand, other])).toEqual({ kind: "ambiguous", ids: ["21", "22"] });
  });

  it("sends an entry carrying two different keys to a person, matching or not", () => {
    const both = (TotalAmt: number) =>
      depositCandidate(deposit("24", "2025-03-04", TotalAmt, { PrivateNote: "[checkin:income:1]\n[checkin:income:2]" }), appKeyOf);
    const req = { ...base, key: "income:1" };
    expect(findMatch([both(123.45)], req)).toEqual({ kind: "ambiguous", ids: ["24"] });
    expect(findMatch([both(1)], req)).toEqual({ kind: "ambiguous", ids: ["24"] });
    expect(findMatch([both(123.45)], { ...base, key: "income:3" })).toEqual({ kind: "ambiguous", ids: ["24"] });
  });

  it("finds the app's entry by key after a bookkeeper adds a line below the marker", () => {
    const edited = depositCandidate(deposit("25", "2025-03-04", 123.45, { PrivateNote: "[checkin:income:1]\nchecked by finance" }), appKeyOf);
    expect(findMatch([edited], { ...base, key: "income:1" })).toEqual({ kind: "found", id: "25", via: "key" });
  });

  it("ignores another record's key entry that does not match, or that its record already holds", () => {
    const off = deposit("22", "2025-03-04", 99, { PrivateNote: "app:gid://shopify/Payout/2" });
    const held = deposit("23", "2025-03-04", 123.45, { PrivateNote: "app:gid://shopify/Payout/2" });
    expect(run([off])).toEqual({ kind: "not-found" });
    expect(run([held], { claimedIds: new Set(["23"]) })).toEqual({ kind: "not-found" });
  });

  it("sends a key hit that is excluded, claimed or duplicated to a person", () => {
    const own = deposit("20", "2025-03-04", 123.45, { PrivateNote: "app:gid://shopify/Payout/1" });
    const twin = deposit("23", "2025-03-04", 123.45, { PrivateNote: "app:gid://shopify/Payout/1" });
    expect(run([own], { excludedIds: new Set(["20"]) })).toEqual({ kind: "ambiguous", ids: ["20"] });
    expect(run([own], { claimedIds: new Set(["20"]) })).toEqual({ kind: "ambiguous", ids: ["20"] });
    expect(run([own, twin])).toEqual({ kind: "ambiguous", ids: ["20", "23"] });
  });

  it("skips the ref check when the request carries none", () => {
    const elsewhere = deposit("3", "2025-03-05", 123.45, { DepositToAccountRef: { value: "36" } });
    expect(run([elsewhere], { ref: undefined })).toEqual({ kind: "found", id: "3", via: "amount" });
  });

  it("rejects bad dates and a reversed window", () => {
    expect(() => run([], { date: "2025-3-3" })).toThrow(/Invalid QBO date/);
    expect(() => run([], { window: { from: "2025-03-10", to: "2025-03-03" } })).toThrow(/reversed/);
  });
});

describe("candidate adapters", () => {
  it("converts QBO decimal amounts to cents", () => {
    expect(depositCandidate(deposit("1", "2025-03-03", 1.005))).toEqual({
      id: "1",
      date: "2025-03-03",
      amountCents: 101,
      ref: "35",
      appKey: undefined,
    });
  });
  it("matches a Purchase on its payment account and a Bill on its vendor", () => {
    const purchase: QboPurchase = { Id: "5", TxnDate: "2025-03-03", TotalAmt: 12, AccountRef: { value: "41" } };
    const bill: QboBill = { Id: "6", TxnDate: "2025-03-03", TotalAmt: 12, VendorRef: { value: "77" }, Balance: 0 };
    expect(purchaseCandidate(purchase)).toMatchObject({ amountCents: 1200, ref: "41" });
    expect(billCandidate(bill, (b) => b.DocNumber)).toMatchObject({ ref: "77", appKey: undefined });
    expect(billCandidate({ ...bill, DocNumber: "exp-9" }, (b) => b.DocNumber)).toMatchObject({ appKey: "exp-9" });
  });
});
