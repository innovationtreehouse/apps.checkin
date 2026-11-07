// The account-mapping rule matcher (docs/rules/expenses.md): expense lines and gifts of goods resolve their account through it.
import type { AccountMapping } from "../db/schema";

/** A line's catalog inputs: its GTIN-13 and the catalog's category and subcategory names. */
export type CatalogInfo = { gtin13: string; category: string; subcategory: string };

function matchesRule(rule: AccountMapping, info: CatalogInfo, item: { isDelayed: boolean; isCapital: boolean }): boolean {
  if (rule.category !== "*" && rule.category !== info.category) return false;
  if (rule.subcategory !== "*" && rule.subcategory !== info.subcategory) return false;
  if (rule.partNumber !== "*" && rule.partNumber !== info.gtin13) return false;
  if (rule.isDelayed !== null && rule.isDelayed !== item.isDelayed) return false;
  if (rule.isCapital !== null && rule.isCapital !== item.isCapital) return false;
  return true;
}

/** The rules a line matches: those naming its exact GTIN-13 when any do, else every rule that covers it. */
export function matchingRules(rules: AccountMapping[], info: CatalogInfo, item: { isDelayed: boolean; isCapital: boolean }): AccountMapping[] {
  const matches = rules.filter((rule) => matchesRule(rule, info, item));
  const exact = matches.filter((r) => r.partNumber === info.gtin13);
  return exact.length > 0 ? exact : matches;
}

/**
 * A donated part's account: the one rule that covers it, matched as a line that is not delayed.
 * Donated equipment matches only rules marked capital, the only rules that may name a fixed-asset account.
 */
export function donatedPartAccount(rules: AccountMapping[], info: CatalogInfo | null, isCapital: boolean): { accountId: string } | { reason: string } {
  if (!info) return { reason: "The catalog has no category and subcategory for this part" };
  const candidates = isCapital ? rules.filter((r) => r.isCapital === true) : rules;
  const matches = matchingRules(candidates, info, { isDelayed: false, isCapital });
  if (matches.length === 1) return { accountId: matches[0].qbAccount };
  if (matches.length > 1) return { reason: `${matches.length} account rules match this part` };
  return { reason: isCapital ? "No account rule marked capital covers this donated equipment" : "No account rule covers this part" };
}
