import { describe, expect, it } from "vitest";
import {
  calculatedCents,
  canAddLine,
  differenceDollars,
  draftMath,
  draftHeader,
  draftLines,
  draftProblem,
  EMPTY_DRAFT,
  EMPTY_LINE,
  hasTypedDetails,
  isDirty,
  parseCents,
  planSave,
  roundingAllowed,
  type Draft,
  type ServerReceipt,
} from "../../components/receiptDraft";

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

  it("refuses what is not a non-negative amount", () => {
    expect(parseCents("")).toBeNull();
    expect(parseCents("-1")).toBeNull();
    expect(parseCents("abc")).toBeNull();
  });
});

describe("calculatedCents", () => {
  it("is lines + shipping + tax − discount, as the server's math check sums it", () => {
    const draft: Draft = { ...EMPTY_DRAFT, header: { discount: "1.00" } };
    expect(calculatedCents(draftLines(receipt, draft), draftHeader(receipt, draft))).toBe(2000 + 500 + 150 - 100);
  });

  it("counts edits, removals and added lines", () => {
    const draft: Draft = {
      header: {},
      lines: { 1: { quantity: "3" } },
      removed: [2],
      added: [{ ...EMPTY_LINE, key: 1, description: "Glue", unitPrice: "2.50" }],
    };
    expect(calculatedCents(draftLines(receipt, draft), draftHeader(receipt, draft))).toBe(1500 + 250 + 500 + 150);
  });

  it("is null while an amount is unreadable", () => {
    const draft: Draft = { ...EMPTY_DRAFT, lines: { 1: { unitPrice: "x" } } };
    expect(calculatedCents(draftLines(receipt, draft), draftHeader(receipt, draft))).toBeNull();
  });
});

describe("draftMath", () => {
  it("balances exactly when the lines, shipping and tax add up to the total", () => {
    expect(draftMath(receipt, EMPTY_DRAFT)).toEqual({ differenceCents: 0, allowedCents: 0, balanced: true });
  });

  it("is the calculated sum minus the draft's total", () => {
    expect(draftMath(receipt, { ...EMPTY_DRAFT, header: { receiptTotal: "27.00" } })).toMatchObject({ differenceCents: -50, balanced: false });
    expect(draftMath(receipt, { ...EMPTY_DRAFT, lines: { 2: { unitPrice: "10.25" } } })).toMatchObject({ differenceCents: 25, balanced: false });
  });

  it("allows a cent of rounding for a line costing a fraction of a cent", () => {
    expect(draftMath(receipt, { ...EMPTY_DRAFT, lines: { 2: { quantity: "1.0005" } } })).toEqual({ differenceCents: 0.5, allowedCents: 1, balanced: true });
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
  });
});

describe("differenceDollars", () => {
  it("shows the real difference, whole cents and fractions of a cent", () => {
    expect(differenceDollars(-50)).toBe("-$0.50");
    expect(differenceDollars(1234)).toBe("$12.34");
    expect(differenceDollars(3.5)).toBe("$0.035");
    expect(differenceDollars(-0.4)).toBe("-$0.004");
  });
});

describe("roundingAllowed", () => {
  it("names the rounding allowed, and says nothing when none was", () => {
    expect(roundingAllowed(0)).toBe("");
    expect(roundingAllowed(2)).toBe(" (rounding of up to $0.02 allowed)");
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
