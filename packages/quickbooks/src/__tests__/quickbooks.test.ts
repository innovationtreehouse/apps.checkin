import { describe, it, expect } from "vitest";
import { isExpired } from "../oauth";
import { toGroundTruth } from "../client";
import type { QboTokens, QboPurchase } from "../types";

const tok = (obtainedAt: number, expiresIn: number): QboTokens => ({
  accessToken: "a", refreshToken: "r", obtainedAt, expiresIn, realmId: "1",
});

describe("isExpired", () => {
  it("fresh token is not expired", () => {
    expect(isExpired(tok(1000, 3600), 1000)).toBe(false);
  });
  it("expires 60s early (refresh margin)", () => {
    // expires_in 3600 → treated expired at obtainedAt + 3540s
    expect(isExpired(tok(0, 3600), 3540_000)).toBe(true);
    expect(isExpired(tok(0, 3600), 3539_000)).toBe(false);
  });
});

describe("toGroundTruth", () => {
  it("maps a Purchase (EntityRef vendor) to the match anchor shape", () => {
    const p: QboPurchase = {
      Id: "42", TxnDate: "2025-03-04", TotalAmt: 128.5,
      EntityRef: { value: "9", name: "Digi-Key Electronics" },
      CurrencyRef: { value: "USD" }, TxnTaxDetail: { TotalTax: 8.5 }, DocNumber: "INV-1",
    };
    expect(toGroundTruth(p)).toEqual({
      qbId: "42", entity: "Purchase", vendor: "Digi-Key Electronics",
      date: "2025-03-04", total: 128.5, tax: 8.5, currency: "USD", docNumber: "INV-1",
      memo: undefined, lines: [],
    });
  });
  it("falls back to VendorRef (Bill) and defaults tax/currency", () => {
    const p: QboPurchase = { Id: "7", TxnDate: "2025-01-01", TotalAmt: 10, VendorRef: { value: "3", name: "Acme" } };
    const g = toGroundTruth(p, "Bill");
    expect(g.vendor).toBe("Acme");
    expect(g.entity).toBe("Bill");
    expect(g.tax).toBe(0);
    expect(g.currency).toBe("USD");
  });
});
