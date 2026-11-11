import { describe, expect, it } from "vitest";
import { disagreementText, lineTotalAfterEdit, receiptMath } from "../../lib/lineMath";
import { validateLineItemMath } from "../../lib/receipt-flow";

// Printed as 3 × $3.33 = $10.00: 3 × $3.333…, the unit price rounded on the receipt.
const printed = { quantity: 3, unitPriceCents: 333, totalPriceCents: 1000 };
// The same line where the receipt prints no line total: quantity × unit price, $9.99.
const calculated = { quantity: 3, unitPriceCents: 333, totalPriceCents: 999 };
// Printed 3 × $3.30 = $10.00: 3 × $3.30 is $9.90, so a figure was misread or misprinted.
const misread = { quantity: 3, unitPriceCents: 330, totalPriceCents: 1000 };

describe("receipt math", () => {
  it("passes a printed line total that rounding explains", () => {
    expect(receiptMath([printed], 0, 0, 0, 1000)).toEqual({ differenceCents: 0, disagreeing: [], balanced: true });
  });

  it("is exact on the stored totals: a calculated $9.99 fails a $10.00 receipt", () => {
    expect(receiptMath([calculated], 0, 0, 0, 1000)).toEqual({ differenceCents: -1, disagreeing: [], balanced: false });
  });

  it("fails a printed line total no rounding explains, even when the receipt total matches it", () => {
    expect(receiptMath([calculated, misread], 0, 0, 0, 1999)).toEqual({ differenceCents: 0, disagreeing: [1], balanced: false });
    expect(disagreementText(misread, 1)).toBe("Line 2: total $10.00 is not 3 × $3.30 ($9.90)");
  });

  it("adds shipping and tax and takes off the discount", () => {
    expect(receiptMath([printed, calculated], 500, 150, 100, 2549).balanced).toBe(true);
    expect(receiptMath([printed, calculated], 500, 150, 100, 2550).balanced).toBe(false);
  });

  it("is the check the server's intake flow runs", () => {
    expect(validateLineItemMath([printed], 0, 0, 0, 1000)).toBe(true);
    expect(validateLineItemMath([calculated], 0, 0, 0, 1000)).toBe(false);
  });
});

describe("a line's total after an edit", () => {
  it("keeps a stored total that a changed unit price still explains", () => {
    // 3 × $3.34 is $10.02; $10.00 is within the 3¢ it may have been rounded or truncated by.
    expect(lineTotalAfterEdit(printed, { quantity: 3, unitPriceCents: 334 })).toBe(1000);
  });

  it("keeps the stored total while quantity and unit price stand", () => {
    expect(lineTotalAfterEdit(printed, { quantity: 3, unitPriceCents: 333 })).toBe(1000);
  });

  it("keeps a printed total that agrees with the corrected quantity or unit price", () => {
    expect(lineTotalAfterEdit(misread, { quantity: 3, unitPriceCents: 333 })).toBe(1000);
  });

  it("is quantity × unit price once the stored total no longer agrees", () => {
    expect(lineTotalAfterEdit(printed, { quantity: 4, unitPriceCents: 333 })).toBe(1332);
    expect(lineTotalAfterEdit(printed, { quantity: 3, unitPriceCents: 340 })).toBe(1020);
  });

  it("rounds a fractional cost to the cent", () => {
    expect(lineTotalAfterEdit({ quantity: 1, unitPriceCents: 333, totalPriceCents: 333 }, { quantity: 1.5, unitPriceCents: 333 })).toBe(500);
  });
});
