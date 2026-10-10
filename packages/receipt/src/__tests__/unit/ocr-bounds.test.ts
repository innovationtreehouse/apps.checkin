import { describe, expect, it } from "vitest";
import { OcrDataSchema } from "../../contract";

const valid = {
  retailer: "OCR Hardware",
  receiptDate: "2026-10-01",
  currency: "USD",
  shipping: 0,
  tax: 0,
  discount: 0,
  receiptTotal: 5,
  lineItems: [{ description: "Nut", quantity: 1, unitPrice: 5, isDelayed: false }],
};
const line = valid.lineItems[0];

describe("OCR output carries the manual-entry bounds", () => {
  it("accepts an ordinary receipt", () => {
    expect(OcrDataSchema.safeParse(valid).success).toBe(true);
  });

  it.each([
    ["more than 200 lines", { lineItems: Array.from({ length: 201 }, () => line) }],
    ["an empty description", { lineItems: [{ ...line, description: "" }] }],
    ["an over-long description", { lineItems: [{ ...line, description: "x".repeat(501) }] }],
    ["a negative unit price", { lineItems: [{ ...line, unitPrice: -1 }] }],
    ["an over-long retailer", { retailer: "x".repeat(501) }],
    ["a total past the cents range", { receiptTotal: 1e12 }],
    ["a negative tax", { tax: -1 }],
  ])("rejects %s", (_label, over) => {
    expect(OcrDataSchema.safeParse({ ...valid, ...over }).success).toBe(false);
  });
});
