import { describe, expect, it } from "vitest";
import { describeCorrection, editsSinceReading, submitterCorrections } from "../../lib/submitterCorrections";

const now = { taxCents: 150, receiptDate: "2026-10-01" };
const edit = (fieldChanged: string, valueBefore: string | null) => ({ fieldChanged, valueBefore });

describe("submitterCorrections", () => {
  it("calls a date entered where it was blank, and a date that held a value changed", () => {
    for (const blank of [null, "", "null", "  "]) {
      expect(submitterCorrections([edit("receiptDate", blank)], now)).toEqual([{ field: "date", kind: "entered", before: null, after: "2026-10-01" }]);
    }
    expect(submitterCorrections([edit("receiptDate", "2026-09-01")], now)).toEqual([{ field: "date", kind: "changed", before: "2026-09-01", after: "2026-10-01" }]);
  });

  it("calls a tax changed from whatever it held, $0 included, in dollars; entered only where it was blank", () => {
    expect(submitterCorrections([edit("taxCents", "0")], now)).toEqual([{ field: "tax", kind: "changed", before: "$0.00", after: "$1.50" }]);
    expect(submitterCorrections([edit("taxCents", null)], now)).toEqual([{ field: "tax", kind: "entered", before: null, after: "$1.50" }]);
    expect(submitterCorrections([edit("taxCents", "100")], now)).toEqual([{ field: "tax", kind: "changed", before: "$1.00", after: "$1.50" }]);
  });

  it("groups thousands in a tax amount", () => {
    expect(submitterCorrections([edit("taxCents", "123456")], now)).toEqual([{ field: "tax", kind: "changed", before: "$1,234.56", after: "$1.50" }]);
  });

  it("compares the value before the first edit with the value now", () => {
    const edits = [edit("taxCents", "100"), edit("taxCents", "120"), edit("receiptDate", "null"), edit("receiptDate", "2026-09-30")];
    expect(submitterCorrections(edits, now)).toEqual([
      { field: "date", kind: "entered", before: null, after: "2026-10-01" },
      { field: "tax", kind: "changed", before: "$1.00", after: "$1.50" },
    ]);
  });

  it("finds none without a tax or date edit", () => {
    expect(submitterCorrections([edit("retailer", "Acme")], now)).toEqual([]);
  });

  it("words each kind for finance", () => {
    expect(describeCorrection({ field: "date", kind: "entered", before: null, after: "2026-10-01" })).toBe("the submitter entered the date (2026-10-01)");
    expect(describeCorrection({ field: "tax", kind: "changed", before: "$1.00", after: "$1.50" })).toBe("the submitter changed the tax from $1.00 to $1.50");
  });
});

describe("editsSinceReading", () => {
  const row = (id: number, action: string) => ({ id, action, fieldChanged: "taxCents", valueBefore: "0" });

  it("keeps every field edit of a receipt that was never read", () => {
    expect(editsSinceReading([row(1, "uploaded"), row(2, "field_edit"), row(3, "field_edit")]).map((r) => r.id)).toEqual([2, 3]);
  });

  it("drops edits a reading replaced, and keeps edits made to what it read", () => {
    const rows = [row(1, "field_edit"), row(2, "ocr_complete"), row(3, "field_edit"), row(4, "ocr_complete"), row(5, "field_edit")];
    expect(editsSinceReading(rows).map((r) => r.id)).toEqual([5]);
  });

  it("leaves no correction behind once a reading replaced the only edit", () => {
    expect(submitterCorrections(editsSinceReading([row(1, "field_edit"), row(2, "ocr_complete")]), now)).toEqual([]);
  });
});
