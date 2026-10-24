import { describe, it, expect } from "vitest";
import { CompletedReceiptSchema } from "@checkin/receipt-types";
import { buildExpenseReceipt, lineResolution } from "../../lib/apply-receipt";
import { buildReceiptPayload } from "../helpers/setup";

const status = (recognitionStatus: string, gtins: { assignedGtin13?: string; provisionalItemGtin13?: string } = {}) => ({
  recognitionStatus,
  assignedGtin13: gtins.assignedGtin13 ?? null,
  provisionalItemGtin13: gtins.provisionalItemGtin13 ?? null,
});

describe("lineResolution", () => {
  it("marks a non-inventory line, with no GTIN", () => {
    expect(lineResolution(status("non_inventory"))).toEqual({ nonInventory: true });
  });

  it("carries the GTIN of recognized and provisional lines", () => {
    expect(lineResolution(status("recognized", { assignedGtin13: "0000000000017" }))).toEqual({ gtin13: "0000000000017" });
    expect(lineResolution(status("provisional", { provisionalItemGtin13: "0000000000123" }))).toEqual({ gtin13: "0000000000123", isProvisional: true });
  });

  it("leaves an unrecognized or unknown line unresolved", () => {
    expect(lineResolution(status("unrecognized"))).toBeUndefined();
    expect(lineResolution(undefined)).toBeUndefined();
  });
});

describe("buildExpenseReceipt", () => {
  it("sends nonInventory on a non-inventory line and leaves other lines unmarked", () => {
    const receipt = CompletedReceiptSchema.parse(buildReceiptPayload({ lineCount: 2 }));
    const [first] = receipt.lineItems;
    const built = CompletedReceiptSchema.parse(
      buildExpenseReceipt(receipt, (li) => (li.receiptLineItemId === first.receiptLineItemId ? { nonInventory: true } : undefined)),
    );
    expect(built.lineItems.map((li) => li.nonInventory)).toEqual([true, undefined]);
    expect(built.lineItems[0].gtin13 ?? null).toBeNull();
  });

  it("drops a GTIN the line arrived with once receiving marks it non-inventory", () => {
    const receipt = CompletedReceiptSchema.parse(buildReceiptPayload());
    const arrived = { ...receipt, lineItems: [{ ...receipt.lineItems[0], gtin13: "0000000000017", isProvisional: true, provisionalName: "Pizza" }] };
    const [line] = CompletedReceiptSchema.parse(JSON.parse(JSON.stringify(buildExpenseReceipt(arrived, () => ({ nonInventory: true }))))).lineItems;
    expect(line).toMatchObject({ nonInventory: true, gtin13: null });
    expect(line.isProvisional).toBeUndefined();
    expect(line.provisionalName).toBeUndefined();
  });
});
