import { describe, expect, it } from "vitest";
import {
  canAddLine,
  draftBalance,
  draftMath,
  draftProblem,
  EMPTY_DRAFT,
  EMPTY_LINE,
  hasTypedDetails,
  isDirty,
  parseCents,
  planSave,
  type Draft,
  type ServerReceipt,
} from "../../components/receiptDraft";
import { validateLineItemMath } from "../../lib/receipt-flow";

const line = (id: number, quantity: number, unitPriceCents: number) => ({
  id, lineNumber: id, description: `Item ${id}`, partNumber: null, manufacturer: null,
  quantity, unitPriceCents, totalPriceCents: quantity * unitPriceCents, isDelayed: false,
});

const receipt: ServerReceipt = {
  retailer: "Acme", receiptDate: "2026-10-01", receiptTotalCents: 2650,
  taxCents: 150, shippingCents: 500, discountCents: 0,
  lineItems: [line(1, 2, 500), line(2, 1, 1000)],
};

describe("parseCents", () => {
  it("reads typed dollars, with or without a $", () => {
    expect(parseCents("12.34")).toBe(1234);
    expect(parseCents("$5")).toBe(500);
    expect(parseCents(".5")).toBe(50);
  });

  it("rounds as @checkin/money does", () => {
    expect(parseCents("1.005")).toBe(101);
    expect(parseCents("3.33")).toBe(333);
    expect(parseCents("10")).toBe(1000);
  });

  it("refuses what is not a non-negative amount", () => {
    expect(parseCents("")).toBeNull();
    expect(parseCents("-1")).toBeNull();
    expect(parseCents("abc")).toBeNull();
  });
});

describe("draftBalance", () => {
  it("is line totals + shipping + tax − discount, as the server stores the lines", () => {
    const draft: Draft = { ...EMPTY_DRAFT, header: { discount: "1.00", receiptTotal: "25.50" } };
    expect(draftBalance(receipt, draft)).toMatchObject({ lineTotalsCents: [1000, 1000], subtotalCents: 2000, calculatedCents: 2550, differenceCents: 0 });
  });

  it("counts edits, removals and added lines", () => {
    const draft: Draft = {
      header: {},
      lines: { 1: { quantity: "3" } },
      removed: [2],
      added: [{ ...EMPTY_LINE, key: 1, description: "Glue", unitPrice: "2.50" }],
    };
    expect(draftBalance(receipt, draft)).toMatchObject({ lineTotalsCents: [1500, 250], calculatedCents: 1500 + 250 + 500 + 150 });
  });

  it("is null where an amount is unreadable", () => {
    expect(draftBalance(receipt, { ...EMPTY_DRAFT, lines: { 1: { unitPrice: "x" } } })).toMatchObject({
      lineTotalsCents: [null, 1000], subtotalCents: null, calculatedCents: null, differenceCents: null, math: null,
    });
    expect(draftBalance(receipt, { ...EMPTY_DRAFT, lines: { 1: { total: "x" } } })).toMatchObject({ lineTotalsCents: [null, 1000], math: null });
  });

  // The receipt prints 3 × $3.33 with no line total, and a $10.00 total; the line is calculated as $9.99.
  const calculated: ServerReceipt = {
    ...receipt, receiptTotalCents: 1000, taxCents: 0, shippingCents: 0,
    lineItems: [{ ...line(1, 3, 333), totalPriceCents: 999 }],
  };

  it("is a cent off while the line keeps its calculated $9.99", () => {
    expect(draftBalance(calculated, EMPTY_DRAFT)).toMatchObject({ lineTotalsCents: [999], differenceCents: -1, math: { balanced: false } });
  });

  it("matches once a person types the line's $10.00", () => {
    expect(draftBalance(calculated, { ...EMPTY_DRAFT, lines: { 1: { total: "10.00" } } })).toMatchObject({
      lineTotalsCents: [1000], differenceCents: 0, math: { balanced: true },
    });
  });

  it("names a line whose total no rounding explains, and keeps that total", () => {
    const misread: ServerReceipt = { ...calculated, lineItems: [{ ...line(1, 3, 330), totalPriceCents: 1000 }] };
    expect(draftBalance(misread, EMPTY_DRAFT)).toMatchObject({
      lineTotalsCents: [1000],
      differenceCents: 0,
      math: { disagreeing: [0], balanced: false },
      disagreements: ["Line 1: total $10.00 is not 3 × $3.30 ($9.90)"],
    });
  });

  it("keeps a stored total that agrees with an edited unit price, and recalculates one that does not", () => {
    const printed: ServerReceipt = { ...calculated, lineItems: [{ ...line(1, 3, 330), totalPriceCents: 1000 }] };
    expect(draftBalance(printed, { ...EMPTY_DRAFT, lines: { 1: { unitPrice: "3.33" } } }).lineTotalsCents).toEqual([1000]);
    expect(draftBalance(printed, { ...EMPTY_DRAFT, lines: { 1: { unitPrice: "4.00" } } }).lineTotalsCents).toEqual([1200]);
  });
});

describe("draftMath", () => {
  it("balances when the line totals, shipping and tax add up to the total", () => {
    expect(draftMath(receipt, EMPTY_DRAFT)).toEqual({ differenceCents: 0, disagreeing: [], balanced: true });
  });

  it("is exact", () => {
    expect(draftMath(receipt, { ...EMPTY_DRAFT, header: { receiptTotal: "26.51" } })).toMatchObject({ differenceCents: -1, balanced: false });
    expect(draftMath(receipt, { ...EMPTY_DRAFT, lines: { 2: { unitPrice: "10.25" } } })).toMatchObject({ differenceCents: 25, balanced: false });
  });

  it("agrees with the server's check on the same lines", () => {
    // Line 2 corrected to 3 × $3.33 keeps its $10.00; corrected to 3 × $3.30 it becomes $9.90.
    const kept: Draft = { ...EMPTY_DRAFT, lines: { 2: { quantity: "3", unitPrice: "3.33" } } };
    const recalculated: Draft = { ...EMPTY_DRAFT, lines: { 2: { quantity: "3", unitPrice: "3.30" } } };
    const lines = (unit: number, total: number) => [{ quantity: 2, unitPriceCents: 500, totalPriceCents: 1000 }, { quantity: 3, unitPriceCents: unit, totalPriceCents: total }];
    expect(draftMath(receipt, kept)?.balanced).toBe(true);
    expect(validateLineItemMath(lines(333, 1000), 500, 150, 0, 2650)).toBe(true);
    expect(draftMath(receipt, recalculated)?.balanced).toBe(false);
    expect(validateLineItemMath(lines(330, 990), 500, 150, 0, 2650)).toBe(false);
  });

  it("is null while an amount is unreadable", () => {
    expect(draftMath(receipt, { ...EMPTY_DRAFT, header: { receiptTotal: "x" } })).toBeNull();
    expect(draftMath(receipt, { ...EMPTY_DRAFT, lines: { 1: { quantity: "" } } })).toBeNull();
  });
});

describe("planSave", () => {
  it("writes nothing for an untouched draft, or one edited back to the saved values", () => {
    expect(planSave(receipt, EMPTY_DRAFT)).toEqual([]);
    expect(isDirty(receipt, { ...EMPTY_DRAFT, header: { retailer: "Acme" }, lines: { 1: { quantity: "2" } } })).toBe(false);
  });

  it("sends only the changed fields, in dollars, and adds lines before removing any", () => {
    const draft: Draft = {
      header: { shipping: "6.00", retailer: "Acme" },
      lines: { 1: { unitPrice: "4.75", partNumber: "  " } },
      removed: [1, 2],
      added: [{ ...EMPTY_LINE, key: 7, description: " Glue ", partNumber: "G-1" }],
    };
    expect(planSave(receipt, draft)).toEqual([
      { path: "", method: "PATCH", body: { shipping: 6 } },
      {
        path: "/line-items",
        method: "POST",
        body: { description: "Glue", partNumber: "G-1", manufacturer: null, quantity: 1, unitPrice: 0, isDelayed: false },
        addedKey: 7,
      },
      { path: "/line-items/1", method: "DELETE" },
      { path: "/line-items/2", method: "DELETE" },
    ]);
  });

  it("sends a typed line total, and leaves a cleared one to the server", () => {
    expect(planSave(receipt, { ...EMPTY_DRAFT, lines: { 2: { total: "10.01" } } })).toEqual([
      { path: "/line-items/2", method: "PATCH", body: { totalPrice: 10.01 } },
    ]);
    expect(planSave(receipt, { ...EMPTY_DRAFT, lines: { 2: { total: " " } } })).toEqual([]);
    const added = { ...EMPTY_LINE, key: 1, description: "Hinge", quantity: "3", unitPrice: "3.33", total: "10.00" };
    expect(planSave(receipt, { ...EMPTY_DRAFT, added: [added] })[0].body).toMatchObject({ quantity: 3, unitPrice: 3.33, totalPrice: 10 });
  });

  it("keeps a typed total equal to the stored one when the unit price changes, and sends it", () => {
    // Stored $10.00 for 3 × $3.33; the unit price is corrected to $3.30 and the printed $10.00 is typed back.
    const printed: ServerReceipt = { ...receipt, lineItems: [{ ...line(1, 3, 333), totalPriceCents: 1000 }] };
    const draft: Draft = { ...EMPTY_DRAFT, lines: { 1: { unitPrice: "3.30", total: "10.00" } } };
    expect(draftBalance(printed, draft).lineTotalsCents).toEqual([1000]);
    expect(planSave(printed, draft)).toEqual([{ path: "/line-items/1", method: "PATCH", body: { unitPrice: 3.3, totalPrice: 10 } }]);
    expect(planSave(printed, { ...EMPTY_DRAFT, lines: { 1: { total: "10.00" } } })).toEqual([]);
  });

  it("patches an edited line with its changed fields only", () => {
    const draft: Draft = { ...EMPTY_DRAFT, lines: { 2: { unitPrice: "9.99", partNumber: "  ", isDelayed: true } } };
    expect(planSave(receipt, draft)).toEqual([
      { path: "/line-items/2", method: "PATCH", body: { unitPrice: 9.99, partNumber: null, isDelayed: true } },
    ]);
  });
});

describe("draftProblem", () => {
  it("allows a complete draft", () => {
    expect(draftProblem(receipt, EMPTY_DRAFT)).toBeNull();
  });

  it("refuses a receipt left with no lines", () => {
    expect(draftProblem(receipt, { ...EMPTY_DRAFT, removed: [1, 2] })).toMatch(/at least one line/);
  });

  it("refuses more lines than the server holds, counting saved lines until removals save", () => {
    const many = { ...receipt, lineItems: Array.from({ length: 199 }, (_, i) => line(i + 1, 1, 100)) };
    const one = { ...EMPTY_LINE, key: 1, description: "Glue" };
    expect(canAddLine(many, EMPTY_DRAFT)).toBe(true);
    expect(canAddLine(many, { ...EMPTY_DRAFT, added: [one] })).toBe(false);
    expect(draftProblem(many, { ...EMPTY_DRAFT, added: [one] })).toBeNull();
    expect(draftProblem(many, { ...EMPTY_DRAFT, removed: [1], added: [one, { ...one, key: 2 }] })).toMatch(/at most 200/);
  });

  it("refuses a blank description or a bad quantity", () => {
    expect(draftProblem(receipt, { ...EMPTY_DRAFT, lines: { 1: { description: " " } } })).toMatch(/description/);
    expect(draftProblem(receipt, { ...EMPTY_DRAFT, lines: { 1: { quantity: "0" } } })).toMatch(/quantity/);
    expect(draftProblem(receipt, { ...EMPTY_DRAFT, lines: { 1: { total: "ten" } } })).toMatch(/line total/);
  });
});

describe("hasTypedDetails", () => {
  const blank: ServerReceipt = { retailer: null, receiptDate: null, receiptTotalCents: null, taxCents: 0, shippingCents: 0, discountCents: 0, lineItems: [] };

  it("is false for a receipt holding nothing but its defaults", () => {
    expect(hasTypedDetails(blank)).toBe(false);
  });

  it("is true for any one detail, a typed $0 total and a single line included", () => {
    for (const typed of [{ retailer: "Acme" }, { receiptDate: "2026-10-01" }, { receiptTotalCents: 0 }, { taxCents: 1 }, { shippingCents: 1 }, { discountCents: 1 }, { lineItems: [line(1, 1, 100)] }]) {
      expect(hasTypedDetails({ ...blank, ...typed })).toBe(true);
    }
  });
});
