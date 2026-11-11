import type { MirrorItem } from "@checkin/income";
import prisma from "@/lib/prisma";
import { membershipVariantYears } from "@/lib/finance/reconcile/membership";
import { membershipYearLabel } from "@/lib/programYear";

type SoldItem = Omit<MirrorItem, "title"> & { title: string | null };

/** Mirror order lines carry the numeric id, which is what income looks a sale's decision up by. */
const legacyId = (variantId: string) => variantId.replace(/^gid:\/\/shopify\/ProductVariant\//, "");

/** Every program and membership variant the app holds, by numeric id, with a readable name. */
async function appItemNames(): Promise<Map<string, string>> {
  const [programs, settings] = await Promise.all([
    prisma.program.findMany({ select: { name: true, shopifyVariantId: true, claimantShopifyVariantId: true } }),
    prisma.boardSettings.findUnique({ where: { id: 1 }, select: { orgMembershipVariantId: true, orgMembershipYearBoundary: true } }),
  ]);
  const names = new Map<string, string>();
  for (const [variantId, year] of await membershipVariantYears(settings ?? null, new Date())) {
    names.set(legacyId(variantId), year === null ? "Membership" : `Membership ${membershipYearLabel(year)}`);
  }
  for (const p of programs) {
    if (p.shopifyVariantId) names.set(legacyId(p.shopifyVariantId), p.name);
    if (p.claimantShopifyVariantId) names.set(legacyId(p.claimantShopifyVariantId), `${p.name} (reserved seat)`);
  }
  return names;
}

/** The items sold so far, plus the app's program and membership items that have not sold yet. */
export async function withAppItems(sold: SoldItem[]): Promise<MirrorItem[]> {
  const names = await appItemNames();
  const soldIds = new Set(sold.map((i) => i.variantId));
  return [
    ...sold.map((i) => ({ ...i, title: i.title ?? names.get(i.variantId) ?? "" })),
    ...[...names].flatMap(([variantId, title]) => (soldIds.has(variantId) ? [] : [{ variantId, title, sku: null }])),
  ];
}
