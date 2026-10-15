import { describe, expect, it } from "vitest";
import { MAX_LINE_QUANTITY } from "@inventory/receipt-types";
import { ImportReceiptSchema } from "../../lib/schemas";

const line = { lineNumber: 1, description: "Nut", quantity: 1, unitPriceCents: 500, totalPriceCents: 500, isDelayed: false };
const valid = {
  importSourceId: "src-1",
  qbTxnId: "qb-1",
  retailer: "Hardware",
  shippingCents: 0,
  taxCents: 0,
  discountCents: 0,
  receiptTotalCents: 500,
  mimeType: "image/png",
  fileBase64: "AA==",
  lineItems: [line],
};
const withLine = (over: Record<string, unknown>) => ({ ...valid, lineItems: [{ ...line, ...over }] });

describe("import receipt money and quantity bounds", () => {
  it("accepts an ordinary receipt and a line at the quantity cap", () => {
    expect(ImportReceiptSchema.safeParse(valid).success).toBe(true);
    expect(ImportReceiptSchema.safeParse(withLine({ quantity: MAX_LINE_QUANTITY })).success).toBe(true);
  });

  it.each([
    ["a negative unit price", withLine({ unitPriceCents: -1 })],
    ["a negative line total", withLine({ totalPriceCents: -1 })],
    ["a quantity over the cap", withLine({ quantity: MAX_LINE_QUANTITY + 1 })],
    ["a negative tax", { ...valid, taxCents: -1 }],
    ["a negative total", { ...valid, receiptTotalCents: -1 }],
  ])("refuses %s", (_label, input) => {
    expect(ImportReceiptSchema.safeParse(input).success).toBe(false);
  });
});
