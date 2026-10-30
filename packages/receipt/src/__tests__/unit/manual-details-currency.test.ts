import { describe, expect, it } from "vitest";
import { ManualDetailsSchema } from "../../lib/schemas";

const details = (currency?: string) => ({
  retailer: "Acme",
  receiptDate: "2026-10-01",
  receiptTotal: "10",
  ...(currency === undefined ? {} : { currency }),
  lineItems: [{ description: "Bolt", quantity: 1, unitPrice: 10 }],
});

describe("ManualDetailsSchema money", () => {
  const withMoney = (money: Record<string, string>) => ManualDetailsSchema.safeParse({ ...details(), ...money }).success;

  it.each(["receiptTotal", "shipping", "tax", "discount"])("refuses a negative or oversized %s", (field) => {
    expect(withMoney({ [field]: "-0.01" })).toBe(false);
    expect(withMoney({ [field]: "21474836.48" })).toBe(false);
  });

  it("accepts zero and the largest amount a column holds", () => {
    expect(withMoney({ tax: "0", receiptTotal: "21474836.47" })).toBe(true);
  });
});

describe("ManualDetailsSchema currency", () => {
  it.each(["USD", "CAD", "EUR"])("accepts the 3-letter code %s", (code) => {
    expect(ManualDetailsSchema.safeParse(details(code)).success).toBe(true);
  });

  it("accepts no currency, which stores as USD", () => {
    expect(ManualDetailsSchema.safeParse(details()).success).toBe(true);
  });

  it.each(["US", "$", "usd", "USDX", "U5D", ""])("refuses %j, which money formatting cannot render", (code) => {
    const result = ManualDetailsSchema.safeParse(details(code));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ path: ["currency"], message: "Currency must be a 3-letter code, like USD" });
  });
});
