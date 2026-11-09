import { describe, expect, it } from "vitest";
import { lineRoundingAgrees } from "./index";

describe("lineRoundingAgrees", () => {
  it("accepts a rounded unit price: 3 × $3.33 printed as $10.00", () => {
    expect(lineRoundingAgrees(1000, 3, 333)).toBe(true);
  });

  it("accepts a truncated unit price: 3 × $4.989 printed as $4.99 each, $14.96", () => {
    expect(lineRoundingAgrees(1496, 3, 499)).toBe(true);
  });

  it("accepts a rounded or truncated total for a fractional quantity: 0.37 × $4.99 = 184.63¢", () => {
    expect(lineRoundingAgrees(185, 0.37, 499)).toBe(true);
    expect(lineRoundingAgrees(184, 0.37, 499)).toBe(true);
    expect(lineRoundingAgrees(183, 0.37, 499)).toBe(false);
    expect(lineRoundingAgrees(186, 0.37, 499)).toBe(false);
  });

  it("allows under a cent per unit, and not a full cent: 2 × $5.00", () => {
    // The true unit price is in ($4.99, $5.01), so the total is in ($9.98, $10.02).
    expect(lineRoundingAgrees(999, 2, 500)).toBe(true);
    expect(lineRoundingAgrees(1000, 2, 500)).toBe(true);
    expect(lineRoundingAgrees(1001, 2, 500)).toBe(true);
    expect(lineRoundingAgrees(998, 2, 500)).toBe(false);
    expect(lineRoundingAgrees(1002, 2, 500)).toBe(false);
  });

  it("is exact for one unit at a whole-cent price", () => {
    expect(lineRoundingAgrees(500, 1, 500)).toBe(true);
    expect(lineRoundingAgrees(501, 1, 500)).toBe(false);
  });

  it("refuses a total no rounding or truncation explains: 3 × $3.30 as $10.00", () => {
    expect(lineRoundingAgrees(1000, 3, 330)).toBe(false);
  });

  it("ignores floating-point noise in quantity × unit price", () => {
    // 0.1 × 300 is 30.000000000000004.
    expect(lineRoundingAgrees(30, 0.1, 300)).toBe(true);
    expect(lineRoundingAgrees(31, 0.1, 300)).toBe(false);
  });
});
