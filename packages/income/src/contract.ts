// Ports the host (checkin-app) binds via configureIncome(). Each is optional: unbound, the
// matching feature no-ops and the CSV side keeps working.

/**
 * Where a mirror row came from, read from the mirror's `source` column on shop_payout and
 * shop_balance_transaction. Finance sees it; matching treats both the same.
 */
export type MirrorSource = "api" | "hand_loaded";

/**
 * Map the mirror's raw `source` value: HAND_LOADED / TEST_LOADED are loaded history;
 * BACKFILL / INCREMENTAL / NULL came from the Shopify API (NULL counts as API).
 */
export function mirrorSource(raw: string | null): MirrorSource {
  return raw === "HAND_LOADED" || raw === "TEST_LOADED" ? "hand_loaded" : "api";
}

/** A payout as the s-read mirror holds it (shop_payout). */
export interface MirrorPayout {
  payoutGid: string;
  issuedAt: Date;
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
}

/** Read-only list of checkin's budget-owner buckets. Same port bulk donation declares. */
export interface OwnerDirectory {
  list(): Promise<OwnerInfo[]>;
}

/**
 * QuickBooks OAuth access-token source. Local stand-in for the type QB-0 adds to
 * `@inventory/quickbooks`; replace with that import once the package is on main.
 */
export interface AccessTokenSource {
  current(): Promise<string>;
}

/** A QuickBooks Deposit, reduced to the fields reconciliation needs. `txnDate` is YYYY-MM-DD. */
export interface QbDeposit {
  id: string;
  txnDate: string;
  totalCents: number;
  depositToAccount: string | null;
}

/** Read-only QuickBooks deposit feed (QB-0's `depositsSince`, built over an AccessTokenSource). */
export interface QbDepositSource {
  depositsSince(from: Date): Promise<QbDeposit[]>;
}
