/**
 * #2 — Proportional penny-allocation algorithm (allocateAmount).
 *
 * All monetary values are integer cents. The cardinal invariant is that the
 * allocated cents sum back to exactly the input total — never losing or
 * inventing a cent. Negative totals (discounts) are exercised explicitly.
 */
import { describe, it, expect } from "vitest";
import { allocateAmount } from "../../lib/expense-qb-processor";

type Item = { id: number; totalPriceCents: number };

function sum(alloc: Map<number, number>): number {
  let total = 0;
  for (const v of alloc.values()) total += v;
  return total;
}

describe("allocateAmount", () => {
  it("distributes proportionally to total price", () => {
    const items: Item[] = [
      { id: 1, totalPriceCents:7500 },
      { id: 2, totalPriceCents:2500 },
    ];
    const alloc = allocateAmount(items, 1000);
    expect(alloc.get(1)).toBe(750);
    expect(alloc.get(2)).toBe(250);
    expect(sum(alloc)).toBe(1000);
  });

  it("conserves every cent when the split is not clean (remainder distribution)", () => {
    const items: Item[] = [
      { id: 1, totalPriceCents:100 },
      { id: 2, totalPriceCents:100 },
      { id: 3, totalPriceCents:100 },
    ];
    const alloc = allocateAmount(items, 10); // 10 cents across 3 → 4/3/3
    expect(sum(alloc)).toBe(10);
    const values = [...alloc.values()].sort((a, b) => a - b);
    expect(values).toEqual([3, 3, 4]);
  });

  it("gives the leftover cent to the highest-priced item first", () => {
    const items: Item[] = [
      { id: 1, totalPriceCents:10000 },
      { id: 2, totalPriceCents:100 },
    ];
    // total 1 cent → floored allocs are 0/0, remainder 1 → goes to id 1.
    const alloc = allocateAmount(items, 1);
    expect(alloc.get(1)).toBe(1);
    expect(alloc.get(2)).toBe(0);
    expect(sum(alloc)).toBe(1);
  });

  it("breaks ties by lowest id when prices are equal", () => {
    const items: Item[] = [
      { id: 5, totalPriceCents:1000 },
      { id: 2, totalPriceCents:1000 },
    ];
    // total 1 cent → one cent to the tie-break winner (lowest id = 2).
    const alloc = allocateAmount(items, 1);
    expect(alloc.get(2)).toBe(1);
    expect(alloc.get(5)).toBe(0);
  });

  it("handles a negative total (a discount) and still conserves the total", () => {
    const items: Item[] = [
      { id: 1, totalPriceCents:6000 },
      { id: 2, totalPriceCents:4000 },
    ];
    const alloc = allocateAmount(items, -1000);
    expect(sum(alloc)).toBe(-1000);
    expect(alloc.get(1)!).toBeLessThanOrEqual(0);
    expect(alloc.get(2)!).toBeLessThanOrEqual(0);
  });

  it("returns all-zero when the total is zero", () => {
    const items: Item[] = [
      { id: 1, totalPriceCents:5000 },
      { id: 2, totalPriceCents:5000 },
    ];
    const alloc = allocateAmount(items, 0);
    expect(alloc.get(1)).toBe(0);
    expect(alloc.get(2)).toBe(0);
  });

  it("returns all-zero when every item has zero price (no divide-by-zero)", () => {
    const items: Item[] = [
      { id: 1, totalPriceCents:0 },
      { id: 2, totalPriceCents:0 },
    ];
    const alloc = allocateAmount(items, 2500);
    expect(alloc.get(1)).toBe(0);
    expect(alloc.get(2)).toBe(0);
    expect(sum(alloc)).toBe(0);
  });

  it("assigns the entire total to a single item", () => {
    const alloc = allocateAmount([{ id: 1, totalPriceCents:4200 }], 777);
    expect(alloc.get(1)).toBe(777);
    expect(sum(alloc)).toBe(777);
  });

  it("returns an empty map for no items", () => {
    expect(allocateAmount([], 10000).size).toBe(0);
  });

  it("conserves cents across many uneven items", () => {
    const items: Item[] = Array.from({ length: 17 }, (_, i) => ({
      id: i + 1,
      totalPriceCents:(i + 1) * 333,
    }));
    const alloc = allocateAmount(items, 12345);
    expect(sum(alloc)).toBe(12345);
    expect(alloc.size).toBe(17);
  });
});
