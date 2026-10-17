/**
 * Non-Prisma response models the Shopify-mirror routes (/api/finance-ops/payments,
 * /api/finance-ops/s-read/*) ship through handler() — the
 * catalogSyntheticClassifications.ts pattern.
 *
 * These are computed shapes (the payment queue joins checkin rows to live mirror
 * amounts; the match audit and diagnose reports are built in code), and handler()'s
 * stripper drops any bag key that isn't a known model. Everything is `internal`
 * (board bookkeeping) except contact data: the payment queue's family email is `pii`,
 * like Person.email, and a mirror order's buyer email is `personal`, like the
 * ShopOrder.customerEmail column it is copied from.
 *
 * Hand-authored, not generated: it describes API responses, not tables. This is a
 * security-boundary artifact — changes ship in a boundary PR.
 */
export const classifications = {
  // One row of the board's payment-exception queue.
  PaymentQueueRow: {
    id: "internal",
    kind: "internal",
    severity: "internal",
    status: "internal",
    shopifyOrderId: "internal",
    processId: "internal",
    programId: "internal",
    personId: "internal",
    detectedAt: "internal",
    familyName: "internal",
    familyEmail: "pii",
    programName: "internal",
  },
  // The live mirror amounts on a queue row (shop_order).
  PaymentQueueLiveOrder: {
    financialStatus: "internal",
    totalCents: "internal",
    totalRefundedCents: "internal",
    cancelledAt: "internal",
  },
  // `{ success }` from POST /api/finance-ops/s-read/sync.
  SReadSyncTrigger: {
    success: "internal",
  },
  // One step of the s-read wiring diagnosis.
  SReadDiagnoseStep: {
    id: "internal",
    ok: "internal",
    detail: "internal",
    code: "internal",
  },
  // The match-audit report (lib/finance/matchAudit.ts MatchAuditResult).
  MatchAuditReport: {
    configured: "internal",
    configuredVariants: "internal",
  },
  MatchAuditVariantCoverage: {
    lines: "internal",
    withVariant: "internal",
  },
  MatchAuditOrderRow: {
    bucket: "internal",
    orderLegacyId: "internal",
    name: "internal",
    customerEmail: "personal",
    financialStatus: "internal",
    totalCents: "internal",
    discountCodes: "internal",
    expected: "internal",
  },
  MatchAuditMembershipRow: {
    bucket: "internal",
    processId: "internal",
    membershipId: "internal",
    householdName: "internal",
    shopifyOrderId: "internal",
    manualPaymentByName: "internal",
  },
  MatchAuditEnrollmentRow: {
    bucket: "internal",
    programId: "internal",
    programName: "internal",
    personId: "internal",
    personName: "internal",
    shopifyOrderId: "internal",
    compedByName: "internal",
  },
  // `{ tracked }` from POST /api/finance-ops/s-read/match-audit/track.
  MatchAuditTrackResult: {
    tracked: "internal",
  },
} as const;

export const relations = {
  PaymentQueueRow: {
    live: { model: "PaymentQueueLiveOrder", isList: false },
  },
  MatchAuditReport: {
    variantCoverage: { model: "MatchAuditVariantCoverage", isList: false },
    orders: { model: "MatchAuditOrderRow", isList: true },
    memberships: { model: "MatchAuditMembershipRow", isList: true },
    enrollments: { model: "MatchAuditEnrollmentRow", isList: true },
  },
} as const;
