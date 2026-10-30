import { describe, expect, it } from "vitest";
import { describeReceipt } from "../../lib/duplicateGroup";

describe("describeReceipt", () => {
  it("groups thousands in the total", () => {
    expect(describeReceipt({ retailer: "Home Depot", receiptDate: "2026-10-03", receiptTotalCents: 123456 })).toBe("Home Depot, 3 Oct, $1,234.56");
  });

  it("leaves out a missing total", () => {
    expect(describeReceipt({ retailer: null, receiptDate: null, receiptTotalCents: null })).toBe("Receipt");
  });
});
