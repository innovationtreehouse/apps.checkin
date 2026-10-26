/** A receipt's tax, shipping or discount spreads across its lines by value and sums to the total. */
import { describe, it, expect } from "vitest";
import { spreadToTotal } from "../../services/inKindAcceptService";

describe("spreadToTotal", () => {
  it.each([
    [[300, 600], 1000, [333, 667]],
    [[100, 100, 100], 400, [134, 133, 133]],
    [[500, 500], 900, [450, 450]],
    [[1000], 1000, [1000]],
    [[0, 0], 101, [51, 50]],
    [[], 0, []],
  ])("spreads %j to %i", (values, total, expected) => {
    expect(spreadToTotal(values, total)).toEqual(expected);
  });

  it("always sums to the total", () => {
    const out = spreadToTotal([7, 13, 29, 51], 1234);
    expect(out.reduce((a, b) => a + b, 0)).toBe(1234);
  });
});
