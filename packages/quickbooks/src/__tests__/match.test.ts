import { describe, expect, it } from "vitest";
import { billCandidate, depositCandidate, findMatch, purchaseCandidate, takeoverLine, type MatchRequest } from "../match";
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
  takeoverLine: "2025-03-01",
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
    expect(run(misses)).toEqual({ kind: "not-found-after-line" });
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
    expect(run(rows, { excludedIds: new Set(["10"]), claimedIds: new Set(["12"]) })).toEqual({
      kind: "not-found-after-line",
    });
  });

  it("finds the app's own creation by the caller's key, whatever its amount or date", () => {
    const own = deposit("20", "2025-01-15", 1, { PrivateNote: "app:gid://shopify/Payout/1" });
    const hand = deposit("21", "2025-03-04", 123.45);
    expect(run([own, hand])).toEqual({ kind: "found", id: "20", via: "key" });
  });

  it("never offers another record's app-created entry as a hand match", () => {
    const other = deposit("22", "2025-03-04", 123.45, { PrivateNote: "app:gid://shopify/Payout/2" });
    expect(run([other])).toEqual({ kind: "not-found-after-line" });
  });

  it("sends a key hit that is excluded, claimed or duplicated to a person", () => {
    const own = deposit("20", "2025-03-04", 123.45, { PrivateNote: "app:gid://shopify/Payout/1" });
    const twin = deposit("23", "2025-03-04", 123.45, { PrivateNote: "app:gid://shopify/Payout/1" });
    expect(run([own], { excludedIds: new Set(["20"]) })).toEqual({ kind: "ambiguous", ids: ["20"] });
    expect(run([own], { claimedIds: new Set(["20"]) })).toEqual({ kind: "ambiguous", ids: ["20"] });
    expect(run([own, twin])).toEqual({ kind: "ambiguous", ids: ["20", "23"] });
  });

  it("answers before-line for a record on or before the takeover line (too old)", () => {
    expect(run([], { date: "2025-03-01" })).toEqual({ kind: "not-found-before-line" });
    expect(run([], { date: "2025-02-27" })).toEqual({ kind: "not-found-before-line" });
    expect(run([], { date: "2025-03-02" })).toEqual({ kind: "not-found-after-line" });
  });

  it("fails closed with no takeover line", () => {
    expect(run([], { takeoverLine: null })).toEqual({ kind: "not-found-no-line" });
  });

  it("still finds a match with no takeover line", () => {
    expect(run([deposit("10", "2025-03-05", 123.45)], { takeoverLine: null })).toMatchObject({ kind: "found" });
  });

  it("skips the ref check when the request carries none", () => {
    const elsewhere = deposit("3", "2025-03-05", 123.45, { DepositToAccountRef: { value: "36" } });
    expect(run([elsewhere], { ref: undefined })).toEqual({ kind: "found", id: "3", via: "amount" });
  });

  it("rejects bad dates and a reversed window", () => {
    expect(() => run([], { date: "2025-3-3" })).toThrow(/Invalid QBO date/);
    expect(() => run([], { takeoverLine: "x" })).toThrow(/Invalid QBO date/);
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

describe("takeoverLine", () => {
  it("is the newest record tied to an entry the app did not create", () => {
    expect(
      takeoverLine([
        { date: "2025-02-01", qbOrigin: "hand" },
        { date: "2025-03-01", qbOrigin: "hand" },
        { date: "2025-02-15", qbOrigin: "hand" },
      ]),
    ).toBe("2025-03-01");
  });
  it("never moves for app-created entries or untied records", () => {
    expect(
      takeoverLine([
        { date: "2025-02-01", qbOrigin: "hand" },
        { date: "2025-06-01", qbOrigin: "app" },
        { date: "2025-07-01", qbOrigin: null },
      ]),
    ).toBe("2025-02-01");
  });
  it("is null (fail closed) with no hand-booked match", () => {
    expect(takeoverLine([])).toBeNull();
    expect(takeoverLine([{ date: "2025-06-01", qbOrigin: "app" }])).toBeNull();
  });
  it("rejects a bad date", () => {
    expect(() => takeoverLine([{ date: "06/01/2025", qbOrigin: "hand" }])).toThrow(/Invalid QBO date/);
  });
});
