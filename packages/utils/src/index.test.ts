import { describe, it, expect } from "vitest";
import { normalizeUrl } from "./index";

describe("normalizeUrl", () => {
  it("keeps a URL that already has a scheme", () => {
    expect(normalizeUrl("  http://example.com/x ")).toBe("http://example.com/x");
  });

  it("prefixes https:// onto a bare hostname", () => {
    expect(normalizeUrl("example.com")).toBe("https://example.com");
  });

  it("returns null for empty or unparseable input", () => {
    expect(normalizeUrl("   ")).toBeNull();
    expect(normalizeUrl("http://")).toBeNull();
  });
});
