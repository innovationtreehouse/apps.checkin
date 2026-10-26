// Where income's expected deposits come from, and what differs between those sources: the key
// income books under, the QuickBooks accounts a deposit resolves to, the match window, and the
// queue note on a deposit dated in closed books. Everything else runs the same on every source.
import { qbKey, type BooksMapRole } from "@checkin/quickbooks";
import type { PayoutReconciliation } from "../generated/prisma/client";
import { getIncomeConfig } from "../runtime";
import type { DepositAccount } from "./deposit-lines";

export const DEPOSIT_SOURCE = { SHOPIFY: "shopify", BENEVITY: "benevity" } as const;
export type DepositSourceName = (typeof DEPOSIT_SOURCE)[keyof typeof DEPOSIT_SOURCE];

export const isBenevity = (row: Pick<PayoutReconciliation, "source">) => row.source === DEPOSIT_SOURCE.BENEVITY;

/** The books-map role each Shopify deposit line books to. */
export const SHOPIFY_LINE_ROLES: Record<DepositAccount, BooksMapRole> = {
  income: "SHOPIFY_SALES",
  charge_remainder: "SHOPIFY_CHARGE_REMAINDER",
  fees: "SHOPIFY_FEES",
  adjustments: "SHOPIFY_ADJUSTMENTS",
};

/** The bank account role each source's deposits land in. */
export const BANK_ROLE: Record<DepositSourceName, BooksMapRole> = {
  shopify: "SHOPIFY_BANK",
  benevity: "BENEVITY_BANK",
};

/** Days either side of a Benevity disbursement a deposit may be dated; finance books these by hand within a week. */
export const BENEVITY_MATCH_WINDOW_DAYS = 7;

export type RoleAccounts = Partial<Record<BooksMapRole, string>>;

/**
 * QuickBooks account id per role: the books map's, else the host's environment setting for the
 * roles that had one before the map (Shopify's five, Benevity's bank). A role neither sets is absent.
 */
export async function roleAccounts(): Promise<RoleAccounts> {
  const { booksMap, bankAccountId, benevityBankAccountId, posting } = getIncomeConfig();
  // ponytail: the environment fallback goes once finance has filled the map (QB_ENTRY_OWNERSHIP PR 4).
  const fallback: RoleAccounts = {
    SHOPIFY_BANK: bankAccountId,
    SHOPIFY_SALES: posting?.accounts?.income,
    SHOPIFY_CHARGE_REMAINDER: posting?.accounts?.charge_remainder,
    SHOPIFY_FEES: posting?.accounts?.fees,
    SHOPIFY_ADJUSTMENTS: posting?.accounts?.adjustments,
    BENEVITY_BANK: benevityBankAccountId,
  };
  const mapped: RoleAccounts = booksMap ? await booksMap.accounts() : {};
  const out: RoleAccounts = {};
  for (const [role, id] of Object.entries({ ...fallback, ...mapped }) as [BooksMapRole, string | undefined][]) {
    if (id) out[role] = id;
  }
  return out;
}

/** The QuickBooks Class per bucket id: the books map's, else each bucket's own link in the owner directory. */
export async function bucketClasses(): Promise<ReadonlyMap<number, string>> {
  const { booksMap, owners } = getIncomeConfig();
  if (booksMap) return booksMap.classes();
  return new Map((await owners?.list() ?? []).flatMap((o) => (o.quickBooksClassId ? [[o.id, o.quickBooksClassId] as const] : [])));
}

/** The key income creates a row's deposit under. */
export function rowKey(row: Pick<PayoutReconciliation, "source" | "payoutGid">): string {
  return isBenevity(row) ? qbKey("income", `benevity:${row.payoutGid}`) : qbKey("income", row.payoutGid);
}

/**
 * Every key a deposit the app created for this row may carry: income's own, and on a Benevity
 * row the key donation created it under before income owned Benevity deposits.
 */
export function rowKeys(row: Pick<PayoutReconciliation, "orgId" | "source" | "payoutGid">): string[] {
  return isBenevity(row) ? [rowKey(row), qbKey("donation", `${row.orgId}:${row.payoutGid}`)] : [rowKey(row)];
}

/** The queue note on a payout whose deposit would land in closed books. */
export const CLOSED_NOTE = "dated in closed books in QuickBooks; it can only be matched or skipped";

/** The queue note on a row whose deposit would land in closed books. */
export function closedNote(row: Pick<PayoutReconciliation, "source" | "payoutDate">, mayCreate: boolean): string {
  if (isBenevity(row) && mayCreate) {
    return `Uploaded after posting was switched on, but dated ${row.payoutDate}, in closed books; skip it`;
  }
  return CLOSED_NOTE;
}
