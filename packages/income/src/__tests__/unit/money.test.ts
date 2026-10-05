import { describe, it, expect } from "vitest";
import { toCents, toCentsNullable } from "../../lib/money";

describe("toCents — valid inputs", () => {
  it("converts whole dollar string", () => {
    expect(toCents("1.00")).toBe(100);
    expect(toCents("100")).toBe(10000);
    expect(toCents("97")).toBe(9700);
  });

  it("converts fractional dollar string", () => {
    expect(toCents("0.99")).toBe(99);
    expect(toCents("1.50")).toBe(150);
    expect(toCents("9.01")).toBe(901);
  });

  it("converts negative values", () => {
    expect(toCents("-3.00")).toBe(-300);
    expect(toCents("-0.50")).toBe(-50);
  });

  it("handles large amounts", () => {
    expect(toCents("999999.99")).toBe(99999999);
  });

  it("rounds floating point at the 3rd decimal", () => {
    expect(toCents("1.234")).toBe(123);
    expect(toCents("1.235")).toBe(124);
    expect(toCents("0.001")).toBe(0);
  });
});

describe("toCents — empty/invalid inputs return 0", () => {
  it("returns 0 for empty string", () => expect(toCents("")).toBe(0));
  it("returns 0 for whitespace", () => expect(toCents("   ")).toBe(0));
  it("returns 0 for undefined", () => expect(toCents(undefined)).toBe(0));
  it("returns 0 for non-numeric string", () => expect(toCents("abc")).toBe(0));
  it("returns 0 for zero", () => expect(toCents("0")).toBe(0));
  it("returns 0 for 0.00", () => expect(toCents("0.00")).toBe(0));
});

describe("toCentsNullable — empty/invalid inputs return null", () => {
  it("returns null for empty string", () => expect(toCentsNullable("")).toBeNull());
  it("returns null for whitespace", () => expect(toCentsNullable("   ")).toBeNull());
  it("returns null for undefined", () => expect(toCentsNullable(undefined)).toBeNull());
  it("returns null for non-numeric", () => expect(toCentsNullable("abc")).toBeNull());
});

describe("toCentsNullable — valid inputs return cents", () => {
  it("converts positive amount", () => expect(toCentsNullable("1.00")).toBe(100));
  it("converts negative amount", () => expect(toCentsNullable("-3.00")).toBe(-300));
  it("converts zero to 0 (not null)", () => expect(toCentsNullable("0")).toBe(0));
});
// Display formatting moved to @inventory/money's `formatCents` and is covered
// by that package's own test suite (packages/money/src/money.test.ts).
