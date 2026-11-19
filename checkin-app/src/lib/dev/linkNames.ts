import type { BooksMapRole } from "@checkin/quickbooks";
import { programProductSlug } from "@/lib/shopify/products";

// The names the dev reset's link step looks up in the QuickBooks sandbox and the
// Shopify dev store, and that the one-time setup scripts create. The local
// stand-in lists carry the same names, so a local reset links too.

/** The sandbox account each books-map role books to, by full name. */
export const DEV_SEED_ROLE_ACCOUNTS: Record<BooksMapRole, string> = {
    SHOPIFY_BANK: "Checking",
    SHOPIFY_CHARGE_REMAINDER: "Sales:Shop sales",
    SHOPIFY_FEES: "Merchant fees",
    SHOPIFY_ADJUSTMENTS: "Sales:Shop sales",
    SHOPIFY_CUSTOM_ITEMS: "Sales:Shop sales",
    BENEVITY_BANK: "Checking",
    EXPENSE_PAYMENT: "Checking",
    INKIND_INCOME: "Donations:In-kind",
    INKIND_CLEARING: "In-kind clearing",
};

/** The sandbox Classes, one per seeded bucket; each Class carries its bucket's name. */
export const DEV_SEED_CLASSES = ["Facility", "Woodworking 101"] as const;

/** The dev-store product that sells membership: one variant per membership year, titled with its opening year ("2026"). */
export const DEV_SEED_MEMBERSHIP_HANDLE = "dev-seed-membership";

/** The dev-store product handle for a seeded program's public product, or its reserved-seat product. */
export function devSeedProgramHandle(programName: string, kind: "public" | "claimant"): string {
    return `dev-seed-program-${programProductSlug(programName)}${kind === "claimant" ? "-reserved-seat" : ""}`;
}
