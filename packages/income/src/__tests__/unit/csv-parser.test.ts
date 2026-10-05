import { describe, it, expect } from "vitest";
import { parseShopifyPayoutCsv } from "../../lib/csv-parser";

const HDR = "Payout Date,Status,Charges,Refunds,Adjustments,Marketplace Sales Tax,Advances,Reserved Funds,Fees,Retried Amount,Total,Currency,Bank Reference";

function csv(...rows: string[]): Buffer {
  return Buffer.from([HDR, ...rows].join("\n"));
}

describe("parseShopifyPayoutCsv — happy paths", () => {
  it("parses a single valid row", () => {
    const [row] = parseShopifyPayoutCsv(csv("2026-05-01,paid,100,0,0,0,0,0,-3,0,97,USD,REF-1"));
    expect(row.payoutDate).toBe("2026-05-01");
    expect(row.status).toBe("paid");
    expect(row.chargesCents).toBe(10000);
    expect(row.feesCents).toBe(-300);
    expect(row.totalCents).toBe(9700);
    expect(row.currency).toBe("USD");
    expect(row.bankReference).toBe("REF-1");
  });

  it("parses multiple rows", () => {
    const rows = parseShopifyPayoutCsv(csv(
      "2026-05-01,paid,100,0,0,0,0,0,-3,0,97,USD,REF-1",
      "2026-05-02,paid,50,0,0,0,0,0,-2,0,48,USD,REF-2",
    ));
    expect(rows).toHaveLength(2);
    expect(rows[1].totalCents).toBe(4800);
    expect(rows[1].bankReference).toBe("REF-2");
  });

  it("handles BOM prefix", () => {
    const bom = "﻿" + HDR + "\n2026-05-01,paid,100,0,0,0,0,0,-3,0,97,USD,REF-1";
    const [row] = parseShopifyPayoutCsv(Buffer.from(bom));
    expect(row.payoutDate).toBe("2026-05-01");
  });

  it("returns empty array for header-only CSV", () => {
    expect(parseShopifyPayoutCsv(csv())).toHaveLength(0);
  });

  it("parses float values correctly", () => {
    const [row] = parseShopifyPayoutCsv(csv("2026-05-01,paid,100.50,0,0,0,0,0,-3.25,0,97.25,USD,REF-1"));
    expect(row.chargesCents).toBe(10050);
    expect(row.feesCents).toBe(-325);
    expect(row.totalCents).toBe(9725);
  });
});

describe("parseShopifyPayoutCsv — edge cases", () => {
  it("blank numeric fields default to 0", () => {
    const [row] = parseShopifyPayoutCsv(csv("2026-05-01,paid,,,,,,,,,97,USD,REF-1"));
    expect(row.chargesCents).toBe(0);
    expect(row.refundsCents).toBe(0);
    expect(row.adjustmentsCents).toBe(0);
    expect(row.totalCents).toBe(9700);
  });

  it("blank bank reference produces null", () => {
    const [row] = parseShopifyPayoutCsv(csv("2026-05-01,paid,100,0,0,0,0,0,-3,0,97,USD,"));
    expect(row.bankReference).toBeNull();
  });

  it("whitespace-only bank reference produces null", () => {
    const [row] = parseShopifyPayoutCsv(csv("2026-05-01,paid,100,0,0,0,0,0,-3,0,97,USD,   "));
    expect(row.bankReference).toBeNull();
  });

  it("non-numeric value in numeric field defaults to 0", () => {
    const [row] = parseShopifyPayoutCsv(csv("2026-05-01,paid,N/A,0,0,0,0,0,-3,0,97,USD,REF-1"));
    expect(row.chargesCents).toBe(0);
  });
});

describe("parseShopifyPayoutCsv — negative paths", () => {
  it("throws on malformed CSV with unclosed quote", () => {
    const bad = Buffer.from(HDR + '\n"unclosed,paid,100,0,0,0,0,0,-3,0,97,USD,REF');
    expect(() => parseShopifyPayoutCsv(bad)).toThrow();
  });
});
