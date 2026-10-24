/** The org-items list order, read from the sortBy/sortDir query. No database. */
import { describe, expect, it } from "vitest";
import { itemOrderBy } from "../../routes/orgItems";

const order = (q: string) => itemOrderBy(new URLSearchParams(q));

describe("itemOrderBy", () => {
  it("orders by part number ascending by default", () => {
    expect(order("")).toEqual([{ gtin13: "asc" }]);
  });

  it("orders by part number descending", () => {
    expect(order("sortBy=gtin13&sortDir=desc")).toEqual([{ gtin13: "desc" }]);
  });

  it("orders by location or backstock name, then part number", () => {
    expect(order("sortBy=location&sortDir=desc")).toEqual([{ location: { name: "desc" } }, { gtin13: "asc" }]);
    expect(order("sortBy=backstock")).toEqual([{ backstockLocation: { name: "asc" } }, { gtin13: "asc" }]);
  });

  it("falls back to part number for an unknown column or direction", () => {
    expect(order("sortBy=name&sortDir=sideways")).toEqual([{ gtin13: "asc" }]);
  });
});
