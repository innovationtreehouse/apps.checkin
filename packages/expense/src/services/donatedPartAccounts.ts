// Gifts of goods book each part where the same purchase would (docs/rules/expenses.md): through expense's account rules.
import { db } from "../db";
import { donatedPartAccount } from "../lib/account-rules";
import { getItem, listCategories, listSubcategories } from "../lib/catalog";

export interface DonatedPart {
  lineId: number;
  gtin13: string;
  isCapital: boolean;
}

export type DonatedPartAccount = { lineId: number } & ({ accountId: string } | { reason: string });

/** Each part's account from the org's rules, with category and subcategory read from the catalog; a part no rule resolves carries why. */
export async function resolveDonatedPartAccounts(orgId: string, parts: DonatedPart[]): Promise<DonatedPartAccount[]> {
  if (parts.length === 0) return [];
  const [rules, categories, subcategories] = await Promise.all([db.accountMapping.findMany({ where: { orgId } }), listCategories(), listSubcategories()]);
  const categoryName = new Map(categories.map((c) => [c.id, c.name]));
  const subcategoryName = new Map(subcategories.map((s) => [s.id, s.name]));
  const out: DonatedPartAccount[] = [];
  for (const part of parts) {
    const item = await getItem(part.gtin13);
    const category = item ? categoryName.get(item.categoryId) : undefined;
    const subcategory = item ? subcategoryName.get(item.subcategoryId) : undefined;
    const info = category && subcategory ? { gtin13: part.gtin13, category, subcategory } : null;
    out.push({ lineId: part.lineId, ...donatedPartAccount(rules, info, part.isCapital) });
  }
  return out;
}
