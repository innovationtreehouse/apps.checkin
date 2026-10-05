// Ports the host (checkin-app) binds via configureIncome(). Each is optional: unbound, the
// matching feature no-ops and the CSV side keeps working.

/** A payout as the s-read mirror holds it (shop_payout). */
export interface MirrorPayout {
  payoutGid: string;
  issuedAt: Date;
  status: string;
  netCents: number;
  currency: string | null;
}

/** One balance transaction of a mirror payout (shop_balance_transaction ⋈ shop_order.name). */
export interface MirrorBalanceTxn {
  txnGid: string;
  type: string;
  orderName: string | null;
  amountCents: number;
  feeCents: number;
  netCents: number;
}

/** Read-only view of the already-ingested Shopify mirror. Never selects customer columns. */
export interface PayoutMirror {
  /** Payouts with status "paid" issued on or after `from`. */
  paidPayoutsSince(from: Date): Promise<MirrorPayout[]>;
  payout(gid: string): Promise<MirrorPayout | null>;
  transactions(payoutGid: string): Promise<MirrorBalanceTxn[]>;
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
