import { describe, expect, it } from "vitest";
import { MAX_LINE_QUANTITY } from "@checkin/receipt-types";
import { checkImportBatch } from "../../lib/importBatch";
import { ImportReceiptSchema } from "../../lib/schemas";

const line = { lineNumber: 1, description: "Nut", quantity: 1, unitPriceCents: 500, totalPriceCents: 500, isDelayed: false };
const valid = {
  importSourceId: "src-1",
  qbTxnId: "qb-1",
  retailer: "Hardware",
  receiptDate: "2023-03-01",
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

describe("import required data", () => {
  it.each([
    ["no date", { receiptDate: undefined }],
    ["a date not written YYYY-MM-DD", { receiptDate: "03/01/2023" }],
    ["a blank retailer", { retailer: "  " }],
    ["no total", { receiptTotalCents: undefined }],
  ])("refuses a row with %s", (_label, over) => {
    expect(ImportReceiptSchema.safeParse({ ...valid, ...over }).success).toBe(false);
  });
});

const textRow = (importSourceId: string, over: Record<string, unknown> = {}) => ({
  ...valid,
  importSourceId,
  mimeType: "text/plain",
  fileBase64: Buffer.from(`historical ${importSourceId}`).toString("base64"),
  ...over,
});

describe("checkImportBatch", () => {
  it("passes a well-formed batch with each row's checked file", () => {
    const checked = checkImportBatch([textRow("a"), textRow("b")]);
    expect(checked.ok && checked.rows.map((r) => [r.row.importSourceId, r.mimeType])).toEqual([["a", "text/plain"], ["b", "text/plain"]]);
  });

  it("lists every bad row by number and importSourceId, with each of its fields", () => {
    const batch = [
      textRow("ok"),
      textRow("no-date", { receiptDate: undefined, retailer: "" }),
      textRow("ok2"),
      textRow("bad-date", { receiptDate: "2023-02-30" }),
    ];
    expect(checkImportBatch(batch)).toEqual({
      ok: false,
      problems: [
        "row 2 (no-date): retailer: The retailer is required, receiptDate: The date is required",
        "row 4 (bad-date): receiptDate: The date must be a real date written YYYY-MM-DD",
      ],
    });
  });

  it("names a row whose file bytes do not match its type", () => {
    const checked = checkImportBatch([textRow("ok"), textRow("pdf", { mimeType: "application/pdf" })]);
    expect(checked.ok).toBe(false);
    expect(!checked.ok && checked.problems).toEqual([expect.stringMatching(/^row 2 \(pdf\): file: /)]);
  });

  it("names a problem with the batch itself", () => {
    expect(checkImportBatch([])).toEqual({ ok: false, problems: [expect.stringMatching(/^the batch: /)] });
  });
});
