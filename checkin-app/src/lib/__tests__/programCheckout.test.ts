import { isProgramCheckoutBroken, PROGRAM_CHECKOUT_BROKEN_WHERE } from "@/lib/programCheckout";

describe("isProgramCheckoutBroken", () => {
  it("free program (no prices) is never broken", () => {
    expect(isProgramCheckoutBroken({
      orgMemberPriceCents: null, nonOrgMemberPriceCents: null, shopifyVariantId: null,
    })).toBe(false);
  });

  it("zero price is treated as free, not broken", () => {
    expect(isProgramCheckoutBroken({
      orgMemberPriceCents: 0, nonOrgMemberPriceCents: 0, shopifyVariantId: null,
    })).toBe(false);
  });

  // One variant covers both tiers — member pricing is a checkout-time discount code.
  it("both tiers priced with the variant set is not broken", () => {
    expect(isProgramCheckoutBroken({
      orgMemberPriceCents: 5000, nonOrgMemberPriceCents: 8000, shopifyVariantId: "gid-1",
    })).toBe(false);
  });

  it("a priced program with no variant is broken", () => {
    expect(isProgramCheckoutBroken({
      orgMemberPriceCents: 5000, nonOrgMemberPriceCents: 8000, shopifyVariantId: null,
    })).toBe(true);
  });

  it("a priced org tier alone with no variant is broken", () => {
    expect(isProgramCheckoutBroken({
      orgMemberPriceCents: 5000, nonOrgMemberPriceCents: null, shopifyVariantId: null,
    })).toBe(true);
  });

  it("a priced non-org tier alone with no variant is broken", () => {
    expect(isProgramCheckoutBroken({
      orgMemberPriceCents: null, nonOrgMemberPriceCents: 8000, shopifyVariantId: null,
    })).toBe(true);
  });
});

// ── predicate ≡ WHERE ────────────────────────────────────────────────────────
// The count query (nav todo-counts) runs PROGRAM_CHECKOUT_BROKEN_WHERE in
// Postgres; the list/detail UI runs isProgramCheckoutBroken in JS. If they
// disagree the badge count contradicts the list it links to, so assert them
// equal over the whole matrix rather than trusting the two to be edited together.

type Row = {
  orgMemberPriceCents: number | null;
  nonOrgMemberPriceCents: number | null;
  shopifyVariantId: string | null;
};

/**
 * Evaluate the subset of Prisma `where` grammar this fragment uses against a row,
 * with SQL null semantics: `field: null` is IS NULL, and `{ gt: n }` on a NULL
 * column is unknown → no match.
 */
function whereMatches(where: Record<string, unknown>, row: Row): boolean {
  for (const [key, clause] of Object.entries(where)) {
    if (key === "OR") {
      if (!(clause as Record<string, unknown>[]).some((c) => whereMatches(c, row))) return false;
      continue;
    }
    const value = (row as unknown as Record<string, unknown>)[key];
    if (clause === null) {
      if (value !== null && value !== undefined) return false;
    } else if (clause && typeof clause === "object" && typeof (clause as { gt?: unknown }).gt === "number") {
      const { gt } = clause as { gt: number };
      if (typeof value !== "number" || !(value > gt)) return false;
    } else {
      throw new Error(`whereMatches: unhandled shape for ${key}: ${JSON.stringify(clause)}`);
    }
  }
  return true;
}

describe("PROGRAM_CHECKOUT_BROKEN_WHERE agrees with isProgramCheckoutBroken", () => {
  const PRICES = [null, 0, 5000];
  const VARIANTS = [null, "gid-1"];

  it("matches the predicate on every price × variant combination", () => {
    for (const orgMemberPriceCents of PRICES) {
      for (const nonOrgMemberPriceCents of PRICES) {
        for (const shopifyVariantId of VARIANTS) {
          const row: Row = { orgMemberPriceCents, nonOrgMemberPriceCents, shopifyVariantId };
          const query = whereMatches(
            PROGRAM_CHECKOUT_BROKEN_WHERE as Record<string, unknown>,
            row,
          );
          expect({ row, broken: query }).toEqual({ row, broken: isProgramCheckoutBroken(row) });
        }
      }
    }
  });
});
