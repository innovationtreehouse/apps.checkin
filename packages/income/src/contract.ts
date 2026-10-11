// Ports the host (checkin-app) binds via configureIncome(). Each is optional: unbound, the
// feature that needs it no-ops.

/**
 * Where a mirror row came from, read from the mirror's `source` column on shop_payout and
 * shop_balance_transaction. Finance sees it; matching treats both the same.
 */
export type MirrorSource = "api" | "hand_loaded";

/**
 * Map the mirror's raw `source` value: HAND_LOADED is loaded history; BACKFILL / INCREMENTAL /
 * NULL came from the Shopify API (NULL counts as API). TEST_LOADED maps to null: test rows
 * must never match a real deposit, so the adapter drops them from every port result.
 */
export function mirrorSource(raw: string | null): MirrorSource | null {
  if (raw === "TEST_LOADED") return null;
  return raw === "HAND_LOADED" ? "hand_loaded" : "api";
}

/** Map the mirror's raw payout status (Shopify's uppercase enum, e.g. PAID) to the port's lowercase. */
export function mirrorPayoutStatus(raw: string): string {
  return raw.toLowerCase();
}

/** A payout as the s-read mirror holds it (shop_payout), never a TEST_LOADED row. */
export interface MirrorPayout {
  payoutGid: string;
  issuedAt: Date;
  /** Lowercase, via mirrorPayoutStatus (e.g. "paid", "in_transit"). */
  status: string;
  netCents: number;
  currency: string | null;
  source: MirrorSource;
}

/** One balance transaction of a mirror payout (shop_balance_transaction ⋈ shop_order.name). */
export interface MirrorBalanceTxn {
  txnGid: string;
  type: string;
  orderGid: string | null;
  orderName: string | null;
  amountCents: number;
  feeCents: number;
  netCents: number;
  source: MirrorSource;
}

/** One order line (shop_order_line). Amounts in cents; `variantId` is null for custom items. */
export interface MirrorOrderLine {
  orderGid: string;
  variantId: string | null;
  title: string;
  sku: string | null;
  quantity: number;
  priceCents: number;
  discountCents: number;
}

/** A variant the mirror has seen, with its latest title and SKU. */
export interface MirrorItem {
  variantId: string;
  title: string;
  sku: string | null;
}

/** Read-only view of the already-ingested Shopify mirror. Never selects customer columns. */
export interface PayoutMirror {
  /** Payouts with status "paid" issued on or after `from`. */
  paidPayoutsSince(from: Date): Promise<MirrorPayout[]>;
  payout(gid: string): Promise<MirrorPayout | null>;
  transactions(payoutGid: string): Promise<MirrorBalanceTxn[]>;
  orderLines(orderGids: string[]): Promise<MirrorOrderLine[]>;
  itemsSeen(): Promise<MirrorItem[]>;
}

/** A budget-owner bucket (checkin's BudgetOwner), the QuickBooks category an item books to. */
export interface OwnerInfo {
  id: number;
  name: string;
  archivedAt: Date | null;
  /** The QuickBooks Class id a created deposit books this bucket's lines to; null until linked. */
  quickBooksClassId: string | null;
}

/** Read-only list of checkin's budget-owner buckets. Same port bulk donation declares. */
export interface OwnerDirectory {
  list(): Promise<OwnerInfo[]>;
}

/** A QuickBooks Deposit, reduced to the fields reconciliation needs. `txnDate` is YYYY-MM-DD. */
export interface QbDeposit {
  id: string;
  txnDate: string;
  totalCents: number;
  depositToAccount: string | null;
  /** The app key a deposit the app created carries; absent on hand-booked deposits. */
  appKey?: string;
}

/**
 * Read-only QuickBooks deposit feed: deposits with txnDate in [from, to], both inclusive
 * YYYY-MM-DD, at most MAX_WINDOW_DAYS wide. `quickBooksDepositSource` binds it to QuickBooks.
 */
export interface QbDepositSource {
  depositsBetween(from: string, to: string): Promise<QbDeposit[]>;
}
