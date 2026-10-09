import { describe, it, expect } from "vitest";
import { centsToDollars, dollarsToCents, dollarsToCentsOrNull, sumCents, formatCents, formatUSD } from "./index";

describe("centsToDollars", () => {
  it("round-trips through dollarsToCents", () => {
    for (const c of [0, 1, 10, 1010, 12345, -5000, 99999999]) expect(dollarsToCents(centsToDollars(c))).toBe(c);
  });
  it("serializes without float noise", () => expect(JSON.stringify(centsToDollars(1010))).toBe("10.1"));
  it("throws on non-integer cents", () => {
    expect(() => centsToDollars(10.5)).toThrow("safe integer");
    expect(() => centsToDollars(NaN)).toThrow("safe integer");
  });
});

describe("dollarsToCents", () => {
  it("converts whole dollar string", () => expect(dollarsToCents("100")).toBe(10000));
  it("converts decimal dollar string", () => expect(dollarsToCents("123.45")).toBe(12345));
  it("converts number input", () => expect(dollarsToCents(99.99)).toBe(9999));
  it("converts zero", () => { expect(dollarsToCents("0")).toBe(0); expect(dollarsToCents(0)).toBe(0); });
  it("converts negative value", () => expect(dollarsToCents("-50.00")).toBe(-5000));
  it("absorbs float representation errors", () => {
    expect(dollarsToCents("10.10")).toBe(1010);
    expect(dollarsToCents(10.1)).toBe(1010);
  });
  it("handles large amounts without overflow", () => expect(dollarsToCents("999999.99")).toBe(99999999));
  it("converts string '0.00'", () => expect(dollarsToCents("0.00")).toBe(0));
  it("throws on empty string (blank ≠ $0.00)", () => expect(() => dollarsToCents("")).toThrow("Invalid monetary value"));
  it("throws on trailing garbage", () => expect(() => dollarsToCents("12.5x")).toThrow("Invalid monetary value"));
  it("throws on NaN string", () => expect(() => dollarsToCents("N/A")).toThrow("Invalid monetary value"));
  it("throws on Infinity", () => expect(() => dollarsToCents(Infinity)).toThrow("Invalid monetary value"));
  it("throws on NaN number", () => expect(() => dollarsToCents(NaN)).toThrow("Invalid monetary value"));
  it("rounds float-product half-cents up (1.005 → 101)", () => expect(dollarsToCents("1.005")).toBe(101));
  it("rounds 7.005 → 701", () => expect(dollarsToCents("7.005")).toBe(701));
  it("rounds 1.015 → 102", () => expect(dollarsToCents("1.015")).toBe(102));
});

describe("dollarsToCentsOrNull", () => {
  it("converts positive amount", () => expect(dollarsToCentsOrNull("1.00")).toBe(100));
  it("converts fractional amount", () => expect(dollarsToCentsOrNull("0.99")).toBe(99));
  it("converts negative amount", () => expect(dollarsToCentsOrNull("-3.00")).toBe(-300));
  it("converts zero to 0 (not null)", () => expect(dollarsToCentsOrNull("0")).toBe(0));
  it("converts large amount", () => expect(dollarsToCentsOrNull("999999.99")).toBe(99999999));
  it("returns null for empty string", () => expect(dollarsToCentsOrNull("")).toBeNull());
  it("returns null for whitespace", () => expect(dollarsToCentsOrNull("   ")).toBeNull());
  it("returns null for undefined", () => expect(dollarsToCentsOrNull(undefined)).toBeNull());
  it("returns null for non-numeric string", () => expect(dollarsToCentsOrNull("abc")).toBeNull());
  it("returns null for trailing garbage (Number(), not parseFloat)", () => expect(dollarsToCentsOrNull("12.5x")).toBeNull());
  it("rounds float-product half-cents up (1.005 → 101)", () => expect(dollarsToCentsOrNull("1.005")).toBe(101));
  it("rounds 7.005 → 701", () => expect(dollarsToCentsOrNull("7.005")).toBe(701));
  it("rounds 1.015 → 102", () => expect(dollarsToCentsOrNull("1.015")).toBe(102));
});

// Both entry points must agree on what is valid — they share one parse helper.
describe("parse convergence", () => {
  const invalid = ["", "   ", "12.5x", "abc", "N/A"];
  for (const v of invalid) {
    it(`both reject ${JSON.stringify(v)}`, () => {
      expect(() => dollarsToCents(v)).toThrow();
      expect(dollarsToCentsOrNull(v)).toBeNull();
    });
  }
  const valid = ["123.45", "-50.00", "0", "1.005"];
  for (const v of valid) {
    it(`both accept ${JSON.stringify(v)} with equal cents`, () => {
      expect(dollarsToCents(v)).toBe(dollarsToCentsOrNull(v));
    });
  }
});

describe("sumCents", () => {
  it("sums two amounts", () => expect(sumCents(100, 200)).toBe(300));
  it("sums zero amounts", () => expect(sumCents(0, 0, 0)).toBe(0));
  it("sums single amount", () => expect(sumCents(500)).toBe(500));
  it("sums many amounts", () => expect(sumCents(10, 10, 10)).toBe(30));
  it("sums negative amounts", () => expect(sumCents(1000, -250)).toBe(750));
  it("returns 0 for no arguments", () => expect(sumCents()).toBe(0));
});

describe("formatCents", () => {
  it("formats whole dollars", () => expect(formatCents(10000)).toBe("$100.00"));
  it("formats cents", () => expect(formatCents(10050)).toBe("$100.50"));
  it("formats single cent", () => expect(formatCents(1)).toBe("$0.01"));
  it("formats zero", () => expect(formatCents(0)).toBe("$0.00"));
  it("formats negative value with leading minus", () => expect(formatCents(-5000)).toBe("-$50.00"));
  it("pads cents below 10 to two digits", () => expect(formatCents(509)).toBe("$5.09"));
  it("groups thousands", () => expect(formatCents(1234567)).toBe("$12,345.67"));
  it("groups large amounts", () => expect(formatCents(99999999)).toBe("$999,999.99"));
  it("formats a non-USD currency", () => expect(formatCents(1234567, "EUR")).toBe("€12,345.67"));
  it("defaults to USD for empty currency", () => expect(formatCents(990, "")).toBe("$9.90"));
  it("returns em-dash for null", () => expect(formatCents(null)).toBe("—"));
  it("returns em-dash for undefined", () => expect(formatCents(undefined)).toBe("—"));
});

describe("formatUSD (deprecated alias of formatCents)", () => {
  it("formats a positive cents value", () => expect(formatUSD(10000)).toBe("$100.00"));
  it("formats sub-dollar cents", () => { expect(formatUSD(100)).toBe("$1.00"); expect(formatUSD(5)).toBe("$0.05"); });
  it("formats zero", () => expect(formatUSD(0)).toBe("$0.00"));
  it("formats negative cents", () => expect(formatUSD(-2550)).toBe("-$25.50"));
  it("returns em-dash for null", () => expect(formatUSD(null)).toBe("—"));
  it("returns em-dash for undefined", () => expect(formatUSD(undefined)).toBe("—"));
  it("is the same function as formatCents", () => expect(formatUSD).toBe(formatCents));
});
