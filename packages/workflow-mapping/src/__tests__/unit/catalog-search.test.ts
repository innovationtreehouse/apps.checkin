import { describe, expect, it } from "vitest";
import { catalogSearchTerm } from "../../lib/catalog-search";

describe("catalogSearchTerm", () => {
  it.each(["", " ", "a", " b "])("gives no search term for %j", (q) => {
    expect(catalogSearchTerm(q)).toBeNull();
  });

  it("trims a long enough query", () => {
    expect(catalogSearchTerm("  drill ")).toBe("drill");
  });
});
