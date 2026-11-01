import { normalizeAuditData } from "@/lib/auditPayload";

// Audit payloads are stored as raw objects, but older rows hold a
// double-encoded JSON string. The reader must render both shapes identically.
describe("normalizeAuditData", () => {
  it("passes a raw object through unchanged (current write shape)", () => {
    const obj = { status: "ACTIVE", via: "card" };
    expect(normalizeAuditData(obj)).toBe(obj);
  });

  it("parses a legacy double-encoded JSON string into an object", () => {
    const legacy = JSON.stringify({ status: "ACTIVE", via: "card" });
    expect(normalizeAuditData(legacy)).toEqual({ status: "ACTIVE", via: "card" });
  });

  it("renders both shapes to the same value the reader will display", () => {
    const object = { householdId: 7, name: "Smith" };
    const legacyString = JSON.stringify(object);
    expect(normalizeAuditData(legacyString)).toEqual(normalizeAuditData(object));
  });

  it("returns null/undefined as-is", () => {
    expect(normalizeAuditData(null)).toBeNull();
    expect(normalizeAuditData(undefined)).toBeUndefined();
  });

  it("hands back an un-parseable string rather than throwing", () => {
    expect(normalizeAuditData("not json")).toBe("not json");
  });
});
