import { describe, it, expect } from "vitest";
import { allocateCents } from "./index";

const sum = (parts: number[]) => parts.reduce((s, p) => s + p, 0);

describe("allocateCents", () => {
  it.each([
    // Design worked examples: a $2.50 Benevity fee across Donation and Match.
    { name: "equal columns", total: 250, weights: [10000, 10000], parts: [125, 125] },
    { name: "two-to-one columns", total: 250, weights: [10000, 5000], parts: [167, 83] },
    { name: "tied fractions go to the larger amount", total: 250, weights: [500, 9500], parts: [12, 238] },
    { name: "a zero column takes no part", total: 250, weights: [4000, 0], parts: [250, 0] },
    { name: "a fee larger than its gifts", total: 250, weights: [1, 2], parts: [83, 167] },
    // Largest fraction, not largest amount: 0.98 beats the 50-cent line's 0.
    { name: "leftover to the largest fraction", total: 2, weights: [50, 49, 1], parts: [1, 1, 0] },
    { name: "tied fractions and amounts go to the earlier part", total: 10, weights: [100, 100, 100], parts: [4, 3, 3] },
    { name: "an exact split", total: 1000, weights: [7500, 2500], parts: [750, 250] },
    { name: "one part takes everything", total: 777, weights: [4200], parts: [777] },
    { name: "a negative total", total: -10, weights: [100, 100, 100], parts: [-3, -3, -4] },
    { name: "a negative total, exact", total: -1000, weights: [6000, 4000], parts: [-600, -400] },
    { name: "a zero total", total: 0, weights: [5000, 5000], parts: [0, 0] },
    { name: "all-zero weights split equally", total: 10, weights: [0, 0, 0], parts: [4, 3, 3] },
    { name: "weights summing to zero split equally", total: 10, weights: [500, -500], parts: [5, 5] },
    { name: "a negative weight", total: 1, weights: [3, -1], parts: [2, -1] },
    { name: "no parts, nothing to allocate", total: 0, weights: [], parts: [] },
  ])("$name", ({ total, weights, parts }) => {
    const got = allocateCents(total, weights);
    expect(got).toEqual(parts);
    expect(sum(got)).toBe(total);
  });

  it("conserves every cent across many uneven parts", () => {
    const weights = Array.from({ length: 17 }, (_, i) => (i + 1) * 333);
    for (const total of [12345, -12345, 1, 9_999_999]) expect(sum(allocateCents(total, weights))).toBe(total);
  });

  it("stays exact where the products pass the safe-integer range", () => {
    const parts = allocateCents(9_000_000_000_001, [3_000_000_000_000, 3_000_000_000_000, 3_000_000_000_000]);
    expect(parts).toEqual([3_000_000_000_001, 3_000_000_000_000, 3_000_000_000_000]);
  });

  it("refuses an amount with no parts to carry it", () => {
    expect(() => allocateCents(10, [])).toThrow(/no parts/);
  });

  it.each([1.5, NaN, Infinity])("refuses a non-integer amount %s", (bad) => {
    expect(() => allocateCents(bad, [1])).toThrow(/safe integer/);
    expect(() => allocateCents(1, [bad])).toThrow(/safe integer/);
  });
});
