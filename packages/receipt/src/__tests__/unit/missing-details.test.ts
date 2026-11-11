import { describe, expect, it } from "vitest";
import { listWords, missingDetails, missingDetailsNote } from "../../lib/missingDetails";
import { EditReceiptSchema, ManualDetailsSchema } from "../../lib/schemas";

const complete = { retailer: "Acme", receiptDate: "2026-10-01", receiptTotalCents: 1000 };

describe("missingDetails", () => {
  it("is empty for a receipt with its retailer, date and total, a $0 total included", () => {
    expect(missingDetails(complete)).toEqual([]);
    expect(missingDetails({ ...complete, receiptTotalCents: 0 })).toEqual([]);
  });

  it("names each missing detail, counting blank or spaces-only text as missing", () => {
    expect(missingDetails({ retailer: null, receiptDate: "", receiptTotalCents: null })).toEqual(["retailer", "date", "total"]);
    expect(missingDetails({ ...complete, retailer: "  " })).toEqual(["retailer"]);
  });

  it("counts a date that is not a real YYYY-MM-DD date as missing", () => {
    for (const receiptDate of ["April", "10/01/2026", "2026-02-30"]) expect(missingDetails({ ...complete, receiptDate })).toEqual(["date"]);
  });

  it("words the list and the note a held receipt carries", () => {
    expect(listWords(["total"])).toBe("total");
    expect(listWords(["retailer", "date"])).toBe("retailer and date");
    expect(listWords(["retailer", "date", "total"])).toBe("retailer, date and total");
    expect(missingDetailsNote(["total"])).toBe("This receipt is missing its total. Fill it in, then confirm.");
    expect(missingDetailsNote(["retailer", "date"])).toBe("This receipt is missing its retailer and date. Fill them in, then confirm.");
  });
});

const typed = (over: Record<string, unknown>) => ({
  retailer: "Acme",
  receiptDate: "2026-10-01",
  receiptTotal: "10",
  lineItems: [{ description: "Bolt", quantity: 1, unitPrice: 10 }],
  ...over,
});

describe("typed details", () => {
  it.each([
    ["retailer", "The retailer is required"],
    ["receiptDate", "The date is required"],
  ])("refuses a blank or spaces-only %s on upload", (field, message) => {
    for (const value of ["", "   "]) {
      const result = ManualDetailsSchema.safeParse(typed({ [field]: value }));
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]).toMatchObject({ path: [field], message });
    }
  });

  it("refuses an upload whose date is not a real YYYY-MM-DD date", () => {
    const result = ManualDetailsSchema.safeParse(typed({ receiptDate: "10/01/2026" }));
    expect(result.error?.issues[0]).toMatchObject({ path: ["receiptDate"], message: "The date must be a real date written YYYY-MM-DD" });
  });

  it("refuses an upload with no total", () => {
    const noTotal: Record<string, unknown> = { ...typed({}) };
    delete noTotal.receiptTotal;
    expect(ManualDetailsSchema.safeParse(noTotal).success).toBe(false);
    expect(ManualDetailsSchema.safeParse(typed({ receiptTotal: "" })).success).toBe(false);
  });

  it("trims the retailer and date it keeps", () => {
    expect(ManualDetailsSchema.parse(typed({ retailer: " Acme ", receiptDate: " 2026-10-01 " }))).toMatchObject({ retailer: "Acme", receiptDate: "2026-10-01" });
  });

  it("refuses an edit that blanks the retailer or date", () => {
    expect(EditReceiptSchema.safeParse({ retailer: "  " }).success).toBe(false);
    expect(EditReceiptSchema.safeParse({ receiptDate: "" }).success).toBe(false);
    expect(EditReceiptSchema.parse({ retailer: " Acme " })).toEqual({ retailer: "Acme" });
  });

  it.each(["10/01/2026", "2026-1-5", "2026-02-30", "2026-13-01", "Oct 1 2026"])("refuses an edited date %j that is not a real YYYY-MM-DD date", (receiptDate) => {
    const result = EditReceiptSchema.safeParse({ receiptDate });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ path: ["receiptDate"], message: "The date must be a real date written YYYY-MM-DD" });
  });

  it("accepts an edited date the picker sends", () => {
    expect(EditReceiptSchema.parse({ receiptDate: "2026-02-28" })).toEqual({ receiptDate: "2026-02-28" });
  });
});
