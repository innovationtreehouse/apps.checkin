import { describe, it, expect } from "vitest";
import { CompletedReceiptSchema, MAX_LINE_QUANTITY } from "@inventory/receipt-types";
import { FIXTURE_MANIFEST, loadRaw } from "./index";

const entry = FIXTURE_MANIFEST.find((e) => e.id === "S1-completed-receipt/single-item-recognized")!;
const receipt = loadRaw(entry) as Record<string, unknown> & { lineItems: Record<string, unknown>[] };
const withLine = (over: Record<string, unknown>) => ({ ...receipt, lineItems: [{ ...receipt.lineItems[0], ...over }] });

describe("CompletedReceipt money and quantity bounds", () => {
  it("accepts the fixture and a line at the quantity cap", () => {
    expect(CompletedReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(CompletedReceiptSchema.safeParse(withLine({ quantity: MAX_LINE_QUANTITY })).success).toBe(true);
  });

  it.each([
    ["a negative unit price", withLine({ unitPriceCents: -1 })],
    ["a negative line total", withLine({ totalPriceCents: -1 })],
    ["a quantity over the cap", withLine({ quantity: MAX_LINE_QUANTITY + 1 })],
    ["a negative tax", { ...receipt, taxCents: -1 }],
    ["a negative shipping", { ...receipt, shippingCents: -1 }],
    ["a negative discount", { ...receipt, discountCents: -1 }],
    ["a negative total", { ...receipt, receiptTotalCents: -1 }],
  ])("refuses %s", (_label, input) => {
    expect(CompletedReceiptSchema.safeParse(input).success).toBe(false);
  });
});
