import { describe, expect, it } from "vitest";
import { AddLineItemSchema, EditReceiptSchema, ImportLineItemSchema, LineItemSchema } from "../../lib/schemas";

const importLine = (unitPriceCents: number) => ({ lineNumber: 1, description: "Bolt", quantity: 1, unitPriceCents, totalPriceCents: 0, isDelayed: false });

describe("money fields stop at the column limit", () => {
  it("takes a dollar field up to 21,474,836.47", () => {
    expect(EditReceiptSchema.safeParse({ receiptTotal: 21474836.47 }).success).toBe(true);
    expect(EditReceiptSchema.safeParse({ receiptTotal: 21474836.48 }).success).toBe(false);
    expect(EditReceiptSchema.safeParse({ receiptTotal: 21474836.471 }).success).toBe(true);
  });

  it("takes a cents field up to 2,147,483,647", () => {
    expect(ImportLineItemSchema.safeParse(importLine(2147483647)).success).toBe(true);
    expect(ImportLineItemSchema.safeParse(importLine(2147483648)).success).toBe(false);
  });

  it("refuses a line whose quantity × unit price would not fit", () => {
    expect(LineItemSchema.safeParse({ description: "Bolt", quantity: 2, unitPrice: 10737418.23 }).success).toBe(true);
    expect(LineItemSchema.safeParse({ description: "Bolt", quantity: 2, unitPrice: 10737418.24 }).success).toBe(false);
    expect(AddLineItemSchema.safeParse({ description: "Bolt", quantity: 2, unitPrice: 10737418.24 }).success).toBe(false);
    expect(AddLineItemSchema.safeParse({ description: "Bolt", quantity: 2, unitPrice: 10737418.24, totalPrice: 1 }).success).toBe(true);
  });
});

describe("LineItemSchema takes numbers only", () => {
  it.each(["", "0x10", "16"])("refuses unit price %j", (unitPrice) => {
    expect(LineItemSchema.safeParse({ description: "Bolt", quantity: 1, unitPrice }).success).toBe(false);
  });

  it("refuses a quantity sent as text", () => {
    expect(LineItemSchema.safeParse({ description: "Bolt", quantity: "2", unitPrice: 1 }).success).toBe(false);
  });
});
