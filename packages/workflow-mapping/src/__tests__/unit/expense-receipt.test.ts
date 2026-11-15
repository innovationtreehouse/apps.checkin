import { describe, it, expect } from "vitest";
import { CompletedReceiptSchema } from "@checkin/receipt-types";
import { buildExpenseReceipt, lineResolution } from "../../lib/apply-receipt";
import { buildReceiptPayload } from "../helpers/setup";

const status = (recognitionStatus: string, gtins: { assignedGtin13?: string; provisionalItemGtin13?: string } = {}) => ({
  recognitionStatus,
  assignedGtin13: gtins.assignedGtin13 ?? null,
  provisionalItemGtin13: gtins.provisionalItemGtin13 ?? null,
  proposedName: null,
});

describe("lineResolution", () => {
  it("marks a non-inventory line, with no GTIN", () => {
    expect(lineResolution(status("non_inventory"))).toEqual({ nonInventory: true });
  });

  it("carries the GTIN of recognized and provisional lines", () => {
    expect(lineResolution(status("recognized", { assignedGtin13: "0000000000017" }))).toEqual({ gtin13: "0000000000017" });
    expect(lineResolution(status("provisional", { provisionalItemGtin13: "0000000000123" }))).toEqual({ gtin13: "0000000000123", isProvisional: true, provisionalName: null });
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

  it("names a provisional part by its proposed name, else by the line's description", () => {
    const receipt = CompletedReceiptSchema.parse(buildReceiptPayload({ lineCount: 2 }));
    const proposed = { ...receipt, lineItems: receipt.lineItems.map((li, i) => ({ ...li, description: i === 0 ? "Y" : "Z" })) };
    const built = buildExpenseReceipt(proposed, (li) => ({
      gtin13: "0200000000015",
      isProvisional: true,
      provisionalName: li.description === "Y" ? "X" : null,
    }));
    expect(built.lineItems.map((li) => li.provisionalName)).toEqual(["X", "Z"]);
  });

  it("carries a provisional line's proposed name from its status", () => {
    expect(lineResolution({ ...status("provisional", { provisionalItemGtin13: "0200000000015" }), proposedName: "X" }))
      .toEqual({ gtin13: "0200000000015", isProvisional: true, provisionalName: "X" });
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
