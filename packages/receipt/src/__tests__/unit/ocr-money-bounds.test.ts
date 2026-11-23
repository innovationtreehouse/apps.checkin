import { describe, expect, it } from "vitest";
import { OcrDataSchema, OcrLineItemSchema } from "../../contract";
import { MAX_CENTS } from "../../lib/schemas";

const LIMIT = MAX_CENTS / 100;
const OVER = 21474836.48;

const line = (unitPrice: number, quantity = 1, totalPrice?: number) => ({
  description: "Lathe", quantity, unitPrice, ...(totalPrice === undefined ? {} : { totalPrice }), isDelayed: false,
});

const reading = (money: Partial<Record<"shipping" | "tax" | "discount" | "receiptTotal", number>>) => ({
  retailer: "Acme",
  receiptDate: "2026-10-01",
  currency: "USD",
  shipping: 0,
  tax: 0,
  discount: 0,
  receiptTotal: 5,
  lineItems: [line(5)],
  ...money,
});

describe("OCR money stops at the money column's limit", () => {
  it("takes a line's unit and total price up to 21,474,836.47", () => {
    expect(OcrLineItemSchema.safeParse(line(LIMIT)).success).toBe(true);
    expect(OcrLineItemSchema.safeParse(line(OVER)).success).toBe(false);
    expect(OcrLineItemSchema.safeParse(line(1, 1, LIMIT)).success).toBe(true);
    expect(OcrLineItemSchema.safeParse(line(1, 1, OVER)).success).toBe(false);
  });

  it("refuses a negative price", () => {
    expect(OcrLineItemSchema.safeParse(line(-0.01)).success).toBe(false);
  });

  it("refuses a line whose quantity × unit price would not fit", () => {
    expect(OcrLineItemSchema.safeParse(line(10737418.23, 2)).success).toBe(true);
    expect(OcrLineItemSchema.safeParse(line(10737418.24, 2)).success).toBe(false);
    expect(OcrLineItemSchema.safeParse(line(10737418.24, 2, 1)).success).toBe(true);
  });

  it.each(["shipping", "tax", "discount", "receiptTotal"] as const)("takes %s up to 21,474,836.47", (field) => {
    expect(OcrDataSchema.safeParse(reading({ [field]: LIMIT })).success).toBe(true);
    expect(OcrDataSchema.safeParse(reading({ [field]: OVER })).success).toBe(false);
  });
});
