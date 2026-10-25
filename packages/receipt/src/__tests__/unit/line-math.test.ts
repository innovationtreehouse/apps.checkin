import { describe, expect, it } from "vitest";
import { receiptMath } from "../../lib/lineMath";
import { validateLineItemMath } from "../../lib/receipt-flow";

const whole = { quantity: 2, unitPriceCents: 500 };
// 1.0005 × $10.00 costs 1000.5¢, a fraction of a cent.
const fractional = { quantity: 1.0005, unitPriceCents: 1000 };

describe("receipt math", () => {
  it("is exact when no line costs a fraction of a cent", () => {
    expect(receiptMath([whole], 0, 0, 0, 1000)).toEqual({ differenceCents: 0, allowedCents: 0, balanced: true });
    expect(receiptMath([whole], 0, 0, 0, 1001)).toEqual({ differenceCents: -1, allowedCents: 0, balanced: false });
  });

  it("allows ±1¢ for one fractional line, and fails at 2¢", () => {
    expect(receiptMath([whole, fractional], 0, 0, 0, 2000)).toMatchObject({ allowedCents: 1, balanced: true });
    expect(receiptMath([whole, fractional], 0, 0, 0, 2001)).toMatchObject({ allowedCents: 1, balanced: true });
    expect(receiptMath([whole, fractional], 0, 0, 0, 2002)).toMatchObject({ differenceCents: -1.5, balanced: false });
    expect(receiptMath([whole, fractional], 0, 0, 0, 1998)).toMatchObject({ differenceCents: 2.5, balanced: false });
  });

  it("allows ±2¢ for two fractional lines", () => {
    // Two fractional lines cost 2001¢; with the whole line, 3001¢.
    expect(receiptMath([whole, fractional, fractional], 0, 0, 0, 3003)).toMatchObject({ differenceCents: -2, allowedCents: 2, balanced: true });
    expect(receiptMath([whole, fractional, fractional], 0, 0, 0, 2999)).toMatchObject({ differenceCents: 2, allowedCents: 2, balanced: true });
    expect(receiptMath([whole, fractional, fractional], 0, 0, 0, 3004)).toMatchObject({ balanced: false });
  });

  it("counts a whole-cent line with floating-point noise as whole", () => {
    // 0.1 × 300 is 30.000000000000004 in floating point.
    expect(receiptMath([{ quantity: 0.1, unitPriceCents: 300 }], 0, 0, 0, 30)).toEqual({ differenceCents: 0, allowedCents: 0, balanced: true });
  });

  it("adds shipping and tax and takes off the discount", () => {
    expect(receiptMath([whole], 500, 150, 100, 1550).balanced).toBe(true);
  });

  it("is the check the server's intake flow runs", () => {
    expect(validateLineItemMath([whole, fractional], 0, 0, 0, 2001)).toBe(true);
    expect(validateLineItemMath([whole, fractional], 0, 0, 0, 2002)).toBe(false);
  });
});
