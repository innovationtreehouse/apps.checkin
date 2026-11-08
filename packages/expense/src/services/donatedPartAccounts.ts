// Gifts of goods book each part where the same purchase would (docs/rules/expenses.md): through expense's account rules.
import { NotWiredError } from "@checkin/component-kit";
import { db } from "../db";
import { donatedPartAccount } from "../lib/account-rules";
import { getItem, listCategories, listSubcategories } from "../lib/catalog";
import { assertOrg } from "../runtime";

export interface DonatedPart {
  lineId: number;
  gtin13: string;
  isCapital: boolean;
}

export type DonatedPartAccount = { lineId: number } & ({ accountId: string } | { reason: string });

/** Each part's account from the org's rules, with category and subcategory read from the catalog; a part no rule resolves carries why. */
export async function resolveDonatedPartAccounts(orgId: string, parts: DonatedPart[]): Promise<DonatedPartAccount[]> {
  await assertOrg(orgId);
  if (parts.length === 0) return [];
  const catalog = await Promise.all([listCategories(), listSubcategories()]).catch((err: unknown) => {
    if (err instanceof NotWiredError) return null;
    throw err;
  });
  if (!catalog) return parts.map((p) => ({ lineId: p.lineId, reason: "catalog not connected" }));
  const [categories, subcategories] = catalog;
  const rules = await db.accountMapping.findMany({ where: { orgId } });
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
