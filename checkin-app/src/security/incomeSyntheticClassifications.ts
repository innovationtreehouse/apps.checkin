/**
 * Non-Prisma response models the income library ships through handler()
 * (#1283 §6; the catalogSyntheticClassifications.ts pattern).
 *
 * Mirror payouts, balance transactions and items, live QuickBooks deposits and
 * reconciliation counts are not Prisma models, and handler()'s stripper drops any
 * bag key that isn't a known model. Every field is `internal` (§7): income data is
 * FINANCE's, with BOARD read.
 *
 * These field lists are also the tiering's precondition: no customer column from
 * the mirror and no QuickBooks `Line[]`, `PrivateNote` or entity ref is listed, so
 * the stripper drops them if an adapter ever passes one through. Adding such a
 * field is a re-tier and ships in its own boundary PR.
 *
 * Hand-authored, not generated: it describes API responses, not tables. This is a
 * security-boundary artifact — changes ship in a boundary PR.
 */
export const classifications = {
  // A paid mirror payout (shop_payout).
  IncomePayoutView: {
    payoutGid: "internal",
    issuedAt: "internal",
    status: "internal",
    netCents: "internal",
    currency: "internal",
    source: "internal",
  },
  // One balance transaction of a payout (shop_balance_transaction ⋈ shop_order.name).
  IncomeBalanceTxnView: {
    txnGid: "internal",
    type: "internal",
    orderGid: "internal",
    orderName: "internal",
    amountCents: "internal",
    feeCents: "internal",
    netCents: "internal",
    source: "internal",
  },
  // A QuickBooks deposit, reduced to what matching needs.
  IncomeQbDepositView: {
    id: "internal",
    txnDate: "internal",
    totalCents: "internal",
    depositToAccount: "internal",
  },
  // A variant the mirror has seen, with the injected org's bucket mapping.
  IncomeItemView: {
    variantId: "internal",
    title: "internal",
    sku: "internal",
    budgetOwnerId: "internal",
    budgetOwnerName: "internal",
  },
  // `total` for GET .../reconciliation/count; the rest is a run's outcome.
  IncomeReconciliationCount: {
    total: "internal",
    status: "internal",
    matched: "internal",
    opened: "internal",
    drifted: "internal",
  },
} as const;

export const relations = {} as const;
