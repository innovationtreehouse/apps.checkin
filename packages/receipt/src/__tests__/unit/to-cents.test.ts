import { describe, expect, it } from "vitest";
import { ManualDetailsSchema, toCents } from "../../lib/schemas";

describe("toCents", () => {
  it("rounds as @checkin/money does", () => {
    expect(toCents("1.005")).toBe(101);
    expect(toCents("3.33")).toBe(333);
    expect(toCents("10")).toBe(1000);
    expect(toCents(" 12.50 ")).toBe(1250);
    expect(toCents(1.005)).toBe(101);
  });

  it("reads a missing amount as 0", () => {
    expect(toCents(undefined)).toBe(0);
  });

  it.each(["12abc", "12.5x", "abc", "", "1e3"])("refuses %j", (v) => {
    expect(() => toCents(v)).toThrow();
  });
});

describe("ManualDetailsSchema dollar fields", () => {
  const details = (receiptTotal: string) => ({
    retailer: "Shop",
    receiptDate: "2026-05-01",
    receiptTotal,
    lineItems: [{ description: "Widget", quantity: 1, unitPrice: 1 }],
  });

  it.each(["0", "12", "12.5", "12.34", "12.345", " 7.00 ", "21474836.47"])("accepts %j", (v) => {
    expect(ManualDetailsSchema.safeParse(details(v)).success).toBe(true);
  });

  it.each(["12abc", "abc", "", "1e3", "-1", "-0.001", "-0.004", "21474836.48", "0x10"])("refuses %j", (v) => {
    expect(ManualDetailsSchema.safeParse(details(v)).success).toBe(false);
  });
});
