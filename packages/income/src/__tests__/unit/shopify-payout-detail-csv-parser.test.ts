import { describe, it, expect } from "vitest";
import { parseShopifyPayoutDetailCsv } from "../../lib/shopify-payout-detail-csv-parser";

const HDR = "Transaction Date,Type,Order,Payout Status,Payout Date,Payout ID,Amount,Fee,Net,Currency";

const DATA_ROW = "2026-05-01,charge,#1001,paid,2026-05-01,PAY-001,59,-1.5,57.5,USD";

function csv(...rows: string[]): Buffer {
  return Buffer.from([HDR, ...rows].join("\n"));
}

describe("parseShopifyPayoutDetailCsv — happy paths", () => {
  it("parses a single charge row", () => {
    const result = parseShopifyPayoutDetailCsv(csv(DATA_ROW));
    expect(result.size).toBe(1);
    const rows = result.get("PAY-001")!;
    expect(rows).toHaveLength(1);
    expect(rows[0].transactionType).toBe("charge");
    expect(rows[0].orderRef).toBe("#1001");
    expect(rows[0].shopifyPayoutId).toBe("PAY-001");
    expect(rows[0].amount).toBe(5900);
    expect(rows[0].fee).toBe(-150);
    expect(rows[0].net).toBe(5750);
    expect(rows[0].currency).toBe("USD");
  });

  it("normalises 'Refund' type to 'refund'", () => {
    const refund = DATA_ROW.replace(",charge,", ",Refund,");
    const result = parseShopifyPayoutDetailCsv(csv(refund));
    expect(result.get("PAY-001")![0].transactionType).toBe("refund");
  });

  it("normalises 'REFUND' (uppercase) to 'refund'", () => {
    const refund = DATA_ROW.replace(",charge,", ",REFUND,");
    const result = parseShopifyPayoutDetailCsv(csv(refund));
    expect(result.get("PAY-001")![0].transactionType).toBe("refund");
  });

  it("groups multiple rows under the same Payout ID", () => {
    const row2 = DATA_ROW.replace(",#1001,", ",#1002,").replace(",59,", ",30,");
    const result = parseShopifyPayoutDetailCsv(csv(DATA_ROW, row2));
    expect(result.size).toBe(1);
    expect(result.get("PAY-001")!).toHaveLength(2);
  });

  it("parses two distinct payout IDs", () => {
    const row2 = DATA_ROW.replace("PAY-001", "PAY-002");
    const result = parseShopifyPayoutDetailCsv(csv(DATA_ROW, row2));
    expect(result.size).toBe(2);
    expect(result.has("PAY-001")).toBe(true);
    expect(result.has("PAY-002")).toBe(true);
  });

  it("returns empty map for header-only CSV", () => {
    expect(parseShopifyPayoutDetailCsv(csv()).size).toBe(0);
  });
});

describe("parseShopifyPayoutDetailCsv — edge cases", () => {
  it("skips rows with missing Payout ID", () => {
    const noId = DATA_ROW.replace(",PAY-001,", ",,");
    const result = parseShopifyPayoutDetailCsv(csv(noId));
    expect(result.size).toBe(0);
  });

  it("null orderRef when Order column is blank", () => {
    const noOrder = DATA_ROW.replace(",#1001,", ",,");
    const result = parseShopifyPayoutDetailCsv(csv(noOrder));
    expect(result.get("PAY-001")![0].orderRef).toBeNull();
  });

  it("unknown type maps to 'charge'", () => {
    const weird = DATA_ROW.replace(",charge,", ",adjustment,");
    const result = parseShopifyPayoutDetailCsv(csv(weird));
    expect(result.get("PAY-001")![0].transactionType).toBe("charge");
  });

  it("blank numeric fields default to 0", () => {
    // Construct row directly with blank Amount/Fee/Net, preserving all 10 columns
    const zeroRow = "2026-05-01,charge,#1001,paid,2026-05-01,PAY-001,,,0,USD";
    const result = parseShopifyPayoutDetailCsv(csv(zeroRow));
    const row = result.get("PAY-001")![0];
    expect(row.amount).toBe(0);
    expect(row.fee).toBe(0);
    expect(row.net).toBe(0);
  });

  it("handles BOM prefix", () => {
    const bom = "﻿" + HDR + "\n" + DATA_ROW;
    const result = parseShopifyPayoutDetailCsv(Buffer.from(bom));
    expect(result.size).toBe(1);
  });
});
