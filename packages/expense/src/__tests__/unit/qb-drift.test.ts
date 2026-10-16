/** QB-3 drift: which fields of a created QuickBooks entry no longer match what was posted. */
import { describe, it, expect } from "vitest";
import { qbKey, type QboBill } from "@inventory/quickbooks";
import { driftOf, todaysSlice, type PostedEntry } from "../../lib/expense-qb-drift";

const key = qbKey("expense", "e1");
const posted: PostedEntry = { key, amountCents: 1000, accounts: ["60", "61"], vendorId: "77" };
const line = (amount: number, account: string) => ({ Amount: amount, AccountBasedExpenseLineDetail: { AccountRef: { value: account } } });
const entry = (over: Partial<QboBill> = {}): QboBill => ({
  Id: "5000",
  TxnDate: "2026-09-10",
  TotalAmt: 10,
  VendorRef: { value: "77" },
  PrivateNote: `Acme\n[checkin:${key}]`,
  Line: [line(3, "61"), line(7, "60")],
  ...over,
});

describe("driftOf", () => {
  it("finds nothing when the entry is as posted, in any line order", () => {
    expect(driftOf(posted, entry())).toEqual([]);
  });

  it("names a missing entry", () => {
    expect(driftOf(posted, undefined)).toEqual(["missing"]);
  });

  it("names each edited field", () => {
    expect(driftOf(posted, entry({ TotalAmt: 10.01 }))).toEqual(["amount"]);
    expect(driftOf(posted, entry({ PrivateNote: "Acme" }))).toEqual(["key"]);
    expect(driftOf(posted, entry({ PrivateNote: `[checkin:${key}] [checkin:${qbKey("expense", "e2")}]` }))).toEqual(["key"]);
    expect(driftOf(posted, entry({ Line: [line(3, "61"), line(7, "62")] }))).toEqual(["accounts"]);
    expect(driftOf(posted, entry({ Line: [line(10, "60")] }))).toEqual(["accounts"]);
    expect(driftOf(posted, entry({ VendorRef: { value: "78" } }))).toEqual(["vendor"]);
    expect(driftOf(posted, entry({ TotalAmt: 12, VendorRef: undefined }))).toEqual(["amount", "vendor"]);
  });

  it("checks no vendor on a Purchase", () => {
    expect(driftOf({ ...posted, vendorId: null }, entry({ VendorRef: undefined }))).toEqual([]);
  });
});

describe("todaysSlice", () => {
  const day = (n: number) => new Date(n * 86_400_000 + 3_600_000);

  it("checks everything when under the cap", () => {
    expect(todaysSlice([1, 2, 3], 5, day(9))).toEqual([1, 2, 3]);
  });

  it("covers every id within ceil(n / cap) days, cap per day", () => {
    const ids = Array.from({ length: 7 }, (_, i) => i);
    const seen = new Set<number>();
    for (let d = 100; d < 103; d++) {
      const slice = todaysSlice(ids, 3, day(d));
      expect(slice).toHaveLength(3);
      slice.forEach((id) => seen.add(id));
    }
    expect(seen.size).toBe(7);
  });
});
