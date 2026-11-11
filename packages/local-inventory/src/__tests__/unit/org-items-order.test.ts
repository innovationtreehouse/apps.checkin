/** The org-items list order and search filter, read from the query. No database. */
import { describe, expect, it } from "vitest";
import { buildGtin13, buildProvisionalGtin13 } from "@checkin/gtin";
import { itemOrderBy, itemSearch } from "../../routes/orgItems";

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

describe("itemSearch", () => {
  const gtinClauses = (q: string, nameGtins: string[] = []) => itemSearch(q, nameGtins).filter((clause) => "gtin13" in clause);

  it("matches a short ID's GTIN exactly, and its typed text as-is", () => {
    expect(gtinClauses("03B0042")).toEqual([
      { gtin13: { contains: "03B0042" } },
      { gtin13: buildGtin13("B", 3, 42) },
    ]);
    expect(gtinClauses("P000123")).toEqual([
      { gtin13: { contains: "P000123" } },
      { gtin13: buildProvisionalGtin13(123) },
    ]);
  });

  it("keeps partial-digit search without an exact match", () => {
    expect(gtinClauses("0200")).toEqual([{ gtin13: { contains: "0200" } }]);
  });

  it("matches the GTINs whose name matched, once each", () => {
    expect(gtinClauses("drill", ["4006381333931", "4006381333931"])).toEqual([
      { gtin13: { contains: "drill" } },
      { gtin13: { in: ["4006381333931"] } },
    ]);
  });

  it("searches location and backstock names", () => {
    expect(itemSearch("shelf")).toEqual([
      { gtin13: { contains: "shelf" } },
      { location: { name: { contains: "shelf", mode: "insensitive" } } },
      { backstockLocation: { name: { contains: "shelf", mode: "insensitive" } } },
    ]);
  });
});
