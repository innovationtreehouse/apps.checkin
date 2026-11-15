import { describe, expect, it } from "vitest";
import { lineFormBody, lineFormStart, lineFormUnchanged, type LineFormFields } from "../../lib/line-form";
import { AssociateBodySchema, ProposeBodySchema } from "../../services/lineItemService";

const complete: LineFormFields = {
  gtin13: "0022222222220",
  name: "  Towels ",
  categoryId: "3",
  subcategoryId: "12",
  usage: "Durable",
  conversionFactor: 6,
};

describe("lineFormBody", () => {
  it("builds an associate body the route accepts", () => {
    const body = lineFormBody("associate", complete);
    expect(body).toEqual({ gtin13: "0022222222220", conversionFactor: 6 });
    expect(AssociateBodySchema.safeParse(body).success).toBe(true);
  });

  it("gives no associate body until an item is chosen", () => {
    expect(lineFormBody("associate", { ...complete, gtin13: null })).toBeNull();
  });

  it("builds a propose body the route accepts", () => {
    const body = lineFormBody("propose", complete);
    expect(body).toEqual({
      proposedName: "Towels", proposedCategoryId: 3, proposedSubcategoryId: 12, proposedUsageBehavior: "Durable", conversionFactor: 6,
    });
    expect(ProposeBodySchema.safeParse(body).success).toBe(true);
  });

  it.each<[string, Partial<LineFormFields>]>([
    ["a blank name", { name: "   " }],
    ["no category", { categoryId: null }],
    ["no subcategory", { subcategoryId: null }],
    ["no usage behavior", { usage: null }],
  ])("gives no propose body with %s", (_, missing) => {
    expect(lineFormBody("propose", { ...complete, ...missing })).toBeNull();
  });
});

describe("lineFormStart", () => {
  it("saving a decided line unchanged keeps its part and conversion factor", () => {
    const start = lineFormStart({ assignedGtin13: "0022222222220", proposedName: null, conversionFactor: 12 });
    expect(lineFormBody("associate", start)).toEqual({ gtin13: "0022222222220", conversionFactor: 12 });
  });

  it("keeps the name and factor when a proposed line is re-proposed", () => {
    const start = lineFormStart({ assignedGtin13: null, proposedName: "Towels", conversionFactor: 4 });
    expect(lineFormBody("propose", { ...start, categoryId: "3", subcategoryId: "12", usage: "Durable" }))
      .toMatchObject({ proposedName: "Towels", conversionFactor: 4 });
  });
});

describe("lineFormUnchanged", () => {
  const start = lineFormStart({ assignedGtin13: "0022222222220", proposedName: null, conversionFactor: 12 });

  it("is unchanged while a decided line keeps its part and factor", () => {
    expect(lineFormUnchanged("associate", start, { ...start })).toBe(true);
  });

  it("ignores fields the associate body doesn't carry", () => {
    expect(lineFormUnchanged("associate", start, { ...start, name: "Towels" })).toBe(true);
  });

  it.each<[string, Partial<LineFormFields>]>([
    ["another part", { gtin13: "0033333333330" }],
    ["another factor", { conversionFactor: 6 }],
  ])("is changed with %s", (_, edit) => {
    expect(lineFormUnchanged("associate", start, { ...start, ...edit })).toBe(false);
  });

  it("is changed once a proposal is complete", () => {
    expect(lineFormUnchanged("propose", start, { ...complete })).toBe(false);
  });
});
