import type { BooksMapRole } from "@checkin/quickbooks";

/** Each books-map role as finance sees it on the books map screen. */
export const BOOKS_MAP_ROLE_LABELS: Record<BooksMapRole, string> = {
  SHOPIFY_BANK: "Shopify payouts: bank account",
  SHOPIFY_SALES: "Shopify: sales",
  SHOPIFY_CHARGE_REMAINDER: "Shopify: card remainder",
  SHOPIFY_FEES: "Shopify: fees",
  SHOPIFY_ADJUSTMENTS: "Shopify: adjustments",
  BENEVITY_BANK: "Benevity disbursements: bank account",
  BENEVITY_DONATIONS: "Benevity: donations",
  BENEVITY_MATCHES: "Benevity: employer matches",
  BENEVITY_FEES: "Benevity: fees",
  EXPENSE_PAYMENT: "Organisation card",
};
