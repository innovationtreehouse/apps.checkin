import type { AssociateBody, ProposeBody } from "../services/lineItemService";

export type LineFormKind = "associate" | "propose";

/** What the receipt page's Associate / Propose form holds; Selects give null until a value is picked. */
export interface LineFormFields {
  gtin13: string | null;
  name: string;
  categoryId: string | null;
  subcategoryId: string | null;
  usage: string | null;
  conversionFactor: number;
}

/** The request body for the line's associate or propose route, or null while a required field is unset. */
export function lineFormBody(form: LineFormKind, f: LineFormFields): AssociateBody | ProposeBody | null {
  if (form === "associate") return f.gtin13 ? { gtin13: f.gtin13, conversionFactor: f.conversionFactor } : null;
  const proposedName = f.name.trim();
  if (!proposedName || !f.categoryId || !f.subcategoryId || !f.usage) return null;
  return {
    proposedName,
    proposedCategoryId: Number(f.categoryId),
    proposedSubcategoryId: Number(f.subcategoryId),
    proposedUsageBehavior: f.usage,
    conversionFactor: f.conversionFactor,
  };
}
