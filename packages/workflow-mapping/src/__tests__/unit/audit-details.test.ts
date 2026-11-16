import { describe, it, expect } from "vitest";
import { parseAuditDetails } from "../../lib/audit";

describe("parseAuditDetails", () => {
  it("returns JSON details as the object", () => {
    expect(parseAuditDetails('{"gtin13":"0000000000017"}')).toEqual({ gtin13: "0000000000017" });
  });

  it("returns plain-text details as the string", () => {
    expect(parseAuditDetails("catalog not connected")).toBe("catalog not connected");
  });

  it("returns null for no details", () => {
    expect(parseAuditDetails(null)).toBeNull();
  });
});
