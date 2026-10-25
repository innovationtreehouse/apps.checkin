import { describe, expect, it } from "vitest";
import { retailerKey } from "../../lib/retailer";

describe("retailerKey", () => {
  it("treats case and extra whitespace as the same retailer", () => {
    expect(retailerKey(" amazon  ")).toBe(retailerKey("Amazon"));
    expect(retailerKey("Acme \t  Hardware")).toBe(retailerKey("acme hardware"));
  });

  it("keeps different names apart", () => {
    expect(retailerKey("Amazon.com")).not.toBe(retailerKey("Amazon"));
  });

  it("leaves a missing retailer missing", () => {
    expect(retailerKey(null)).toBeNull();
  });
});
