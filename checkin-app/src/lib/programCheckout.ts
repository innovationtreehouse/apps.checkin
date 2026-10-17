import type { Prisma } from "@/generated/prisma/client";

/**
 * A program is "checkout-broken" when it has a price on a tier but no matching
 * Shopify variant to sell it — paid enrollment silently can't complete (the
 * parent can't pay; the orders/paid webhook never fires, so the participant sits
 * PENDING forever). This state exists because variant IDs are minted only at
 * program-create time (api/programs POST); a program made free, then priced via
 * edit (api/programs/[id] PATCH), never gets variants.
 *
 * A FREE program legitimately has no variant, so gate on a tier being priced at
 * all — never flag on a missing variant alone.
 *
 * Single-pool model (product decision 2026-07-06): `shopifyVariantId` covers
 * BOTH tiers by itself — member pricing is a checkout-time discount code, not a
 * separate variant — so it is the only variant a priced program needs.
 *
 * The JS predicate and the Prisma WHERE below are the same condition on two sides
 * of the wire — the count query (nav/todo-counts) and the per-row/detail UI.
 * programCheckout.test.ts evaluates the WHERE in memory against the full price ×
 * variant matrix and asserts it equals the predicate, so editing one half alone
 * fails the suite.
 */
type CheckoutFields = {
  orgMemberPriceCents?: number | null;
  nonOrgMemberPriceCents?: number | null;
  shopifyVariantId?: string | null;
};

export function isProgramCheckoutBroken(p: CheckoutFields): boolean {
  if (p.shopifyVariantId) return false; // single pool covers both tiers
  return (p.orgMemberPriceCents ?? 0) > 0 || (p.nonOrgMemberPriceCents ?? 0) > 0;
}

export const PROGRAM_CHECKOUT_BROKEN_WHERE: Prisma.ProgramWhereInput = {
  shopifyVariantId: null,
  OR: [
    { orgMemberPriceCents: { gt: 0 } },
    { nonOrgMemberPriceCents: { gt: 0 } },
  ],
};
