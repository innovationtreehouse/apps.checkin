import { dollarsToCents, dollarsToCentsOrNull, formatCents } from "@checkin/money";

// Guards the dollars→cents store / cents→dollars display round-trip used by the
// Program price API boundary. Cents must not truncate $25.99 → $25.
describe("program price cents round-trip", () => {
  it("stores $25.99 as cents and renders it back without truncation", () => {
    const cents = dollarsToCentsOrNull("25.99");
    expect(cents).toBe(2599);
    expect(formatCents(cents)).toBe("$25.99");
  });

  it("treats empty/missing nullable price as null → '—'", () => {
    expect(dollarsToCentsOrNull("")).toBeNull();
    expect(dollarsToCentsOrNull(undefined)).toBeNull();
    expect(formatCents(null)).toBe("—");
  });

  it("required program price round-trips through cents", () => {
    expect(formatCents(dollarsToCents("40.00"))).toBe("$40.00");
  });
});
