import { describe, expect, it } from "vitest";
import { OcrLineItemSchema } from "../../contract";
import { AddLineItemSchema, LINE_COST_MESSAGE } from "../../lib/schemas";

const refusal = (result: { success: boolean; error?: { issues: { message: string; path: PropertyKey[] }[] } }) => {
  expect(result.success).toBe(false);
  return result.error?.issues.map(({ message, path }) => ({ message, path }));
};

describe("a line whose quantity × unit price does not fit is refused on unitPrice", () => {
  it("keeps LINE_COST_MESSAGE after Zod rewrites LINE_COST_RANGE on first use", () => {
    const manual = { description: "Saw", quantity: 2, unitPrice: 10737418.24 };
    const ocr = { description: "Saw", quantity: 3, unitPrice: 10_000_000, isDelayed: false };
    const expected = [{ message: LINE_COST_MESSAGE, path: ["unitPrice"] }];

    expect(refusal(AddLineItemSchema.safeParse(manual))).toEqual(expected);
    expect(refusal(OcrLineItemSchema.safeParse(ocr))).toEqual(expected);
    expect(refusal(AddLineItemSchema.safeParse(manual))).toEqual(expected);
    expect(refusal(OcrLineItemSchema.safeParse(ocr))).toEqual(expected);
  });
});

describe("a line whose quantity × unit price is exactly the limit", () => {
  it("parses", () => {
    expect(AddLineItemSchema.safeParse({ description: "Saw", quantity: 1, unitPrice: 21474836.47 }).success).toBe(true);
  });
});
