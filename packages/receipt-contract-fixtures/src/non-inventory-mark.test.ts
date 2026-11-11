import { describe, it, expect } from "vitest";
import { CompletedReceiptSchema } from "@checkin/receipt-types";
import { FIXTURE_MANIFEST, loadRaw } from "./index";

const raw = (id: string) => loadRaw(FIXTURE_MANIFEST.find((e) => e.id === id)!) as { lineItems: Record<string, unknown>[] };

describe("CompletedReceipt line nonInventory mark", () => {
  it("parses a payload without the mark, leaving it unset", () => {
    const parsed = CompletedReceiptSchema.parse(raw("S2-expense-receipt/all-recognized-gtin"));
    expect(parsed.lineItems.every((li) => li.nonInventory === undefined)).toBe(true);
  });

  it("carries the mark on the non-inventory line only", () => {
    const parsed = CompletedReceiptSchema.parse(raw("S2-expense-receipt/has-non-inventory"));
    expect(parsed.lineItems.map((li) => li.nonInventory)).toEqual([undefined, true]);
    expect(parsed.lineItems[1].gtin13).toBeUndefined();
  });

  it("refuses a mark that is not a boolean", () => {
    const receipt = raw("S2-expense-receipt/has-non-inventory");
    const bad = { ...receipt, lineItems: [{ ...receipt.lineItems[1], nonInventory: "yes" }] };
    expect(CompletedReceiptSchema.safeParse(bad).success).toBe(false);
  });
});
