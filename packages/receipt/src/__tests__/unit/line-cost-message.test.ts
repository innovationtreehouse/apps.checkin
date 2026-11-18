import { describe, expect, it } from "vitest";
import { OcrLineItemSchema } from "../../contract";
import { AddLineItemSchema, LINE_COST_MESSAGE } from "../../lib/schemas";

const refusal = (result: { success: boolean; error?: { issues: { message: string; path: PropertyKey[] }[] } }) => {
  expect(result.success).toBe(false);
  return result.error?.issues.map(({ message, path }) => ({ message, path }));
};

describe("a line whose quantity × unit price does not fit is refused on unitPrice", () => {
  it("reports LINE_COST_MESSAGE for manual and OCR lines, after the shared params object was used", () => {
    const manual = { description: "Saw", quantity: 2, unitPrice: 10737418.24 };
    const ocr = { description: "Saw", quantity: 3, unitPrice: 10_000_000, isDelayed: false };
    const expected = [{ message: LINE_COST_MESSAGE, path: ["unitPrice"] }];

    expect(refusal(AddLineItemSchema.safeParse(manual))).toEqual(expected);
    expect(refusal(OcrLineItemSchema.safeParse(ocr))).toEqual(expected);
    expect(refusal(AddLineItemSchema.safeParse(manual))).toEqual(expected);
    expect(refusal(OcrLineItemSchema.safeParse(ocr))).toEqual(expected);
  });
});
