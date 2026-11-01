import { describe, expect, it } from "vitest";
import { formatCents } from "@checkin/money";
import { CompletedReceiptSchema } from "@checkin/receipt-types";
import { OcrDataSchema } from "../../contract";
import { mapRawToOcrData } from "../../lib/ocr";
import { EditReceiptSchema, ImportReceiptSchema } from "../../lib/schemas";

const REFUSAL = "Currency must be a 3-letter code, like USD";

const imported = (currency?: string) => ({
  importSourceId: "src-1",
  qbTxnId: "txn-1",
  retailer: "Acme",
  receiptDate: "2026-10-01",
  ...(currency === undefined ? {} : { currency }),
  shippingCents: 0,
  taxCents: 0,
  discountCents: 0,
  receiptTotalCents: 500,
  mimeType: "application/pdf",
  fileBase64: "AAAA",
  lineItems: [{ lineNumber: 1, description: "Bolt", quantity: 1, unitPriceCents: 500, totalPriceCents: 500, isDelayed: false }],
});

const reading = (currency: unknown) => ({
  retailer: "Acme",
  receiptDate: "2026-10-01",
  currency,
  shipping: 0,
  tax: 0,
  discount: 0,
  receiptTotal: 5,
  lineItems: [{ description: "Bolt", quantity: 1, unitPrice: 5, isDelayed: false }],
});

const completed = (currency?: string) => ({
  receiptId: "r-1",
  orgId: "org-1",
  submitterId: 1,
  vendorName: "Acme",
  receiptNumber: null,
  orderNumber: null,
  ...(currency === undefined ? {} : { currency }),
  taxCents: 0,
  shippingCents: 0,
  discountCents: 0,
  receiptTotalCents: 500,
  receiptDate: "2026-10-01",
  needsReimbursement: false,
  reimbursementFor: null,
  submittedAt: "2026-10-01T00:00:00.000Z",
  lineItems: [{ receiptLineItemId: 1, lineNumber: 1, description: "Bolt", partNumber: null, manufacturer: null, quantity: 1, unitPriceCents: 500, totalPriceCents: 500, isDelayed: false }],
});

describe("a code money formatting cannot render", () => {
  it.each(["US$", "USDX", "$"])("%j crashes formatCents", (code) => {
    expect(() => formatCents(500, code)).toThrow(RangeError);
  });
});

describe("every path that writes a receipt's currency", () => {
  it.each(["US$", "USDX", "usd", "$", ""])("edit refuses %j and says why", (code) => {
    const result = EditReceiptSchema.safeParse({ currency: code });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ path: ["currency"], message: REFUSAL });
  });

  it.each(["US$", "USDX", "usd", "$", ""])("import refuses %j and says why", (code) => {
    const result = ImportReceiptSchema.safeParse(imported(code));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ path: ["currency"], message: REFUSAL });
  });

  it.each(["US$", "USDX", "usd", "$", ""])("a reading of %j is out of bounds", (code) => {
    expect(OcrDataSchema.safeParse(reading(code)).success).toBe(false);
  });

  it.each(["US$", "USDX", "usd", "$", ""])("the completed-receipt contract refuses %j", (code) => {
    expect(CompletedReceiptSchema.safeParse(completed(code)).success).toBe(false);
  });

  it("each path accepts a real code", () => {
    expect(EditReceiptSchema.parse({ currency: "CAD" }).currency).toBe("CAD");
    expect(ImportReceiptSchema.parse(imported("CAD")).currency).toBe("CAD");
    expect(OcrDataSchema.parse(reading("CAD")).currency).toBe("CAD");
    expect(CompletedReceiptSchema.parse(completed("CAD")).currency).toBe("CAD");
  });

  it("import and the contract default a missing code to USD", () => {
    expect(ImportReceiptSchema.parse(imported()).currency).toBe("USD");
    expect(CompletedReceiptSchema.parse(completed()).currency).toBe("USD");
  });
});

describe("mapping what the model read", () => {
  it.each([
    ["a blank", ""],
    ["a missing", undefined],
  ])("reads %s code as the schema's default, USD", (_label, code) => {
    expect(mapRawToOcrData(reading(code)).currency).toBe("USD");
  });

  it("uppercases a code the model wrote in lower case", () => {
    expect(mapRawToOcrData(reading(" cad ")).currency).toBe("CAD");
  });

  it("throws on a code it cannot read, so the reading lands in ocr_failed", () => {
    expect(() => mapRawToOcrData(reading("US$"))).toThrow();
  });
});
