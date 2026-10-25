import { describe, expect, it } from "vitest";
import { lineFormBody, type LineFormFields } from "../../lib/line-form";
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
