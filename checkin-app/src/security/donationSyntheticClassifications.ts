/**
 * Non-Prisma response models the bulk-donation library ships through handler()
 * (#1280 §4/§5; the catalogSyntheticClassifications.ts pattern).
 *
 * DonationNavCounts — the Finance tab badges: two scalar queue sizes, `public`
 * like every count model (no actor, no donor, no amount).
 *
 * DonationQbCandidateView — one QuickBooks entry offered to finance as a match
 * for a disbursement. id/type/date/amountCents are financial plumbing (`internal`);
 * `memo` is hand-entered QuickBooks free text that may name a donor, so `pii`.
 *
 * InKindQueueItemView — one in-kind donation in the finance queue: its money side
 * arrived with no donor yet, or it was withdrawn after the money arrived. Receipt
 * id, amount, date and the three join timestamps, all `internal`. It carries no
 * donor field, so a donor name on the row is stripped from every view.
 *
 * ManualInKindRecordResult — the reply to recording a no-receipt in-kind
 * donation: its id and whether its goods loaded into inventory, both `internal`.
 *
 * Hand-authored, not generated: these describe API responses, not tables. This
 * is a security-boundary artifact — changes ship in a boundary PR.
 */
export const classifications = {
  DonationNavCounts: {
    unassignedQueue: "public",
    disbursementHolds: "public",
  },
  DonationQbCandidateView: {
    id: "internal",
    type: "internal",
    date: "internal",
    amountCents: "internal",
    memo: "pii",
  },
  InKindQueueItemView: {
    id: "internal",
    receiptId: "internal",
    receiptTotalCents: "internal",
    receiptDate: "internal",
    moneyReceivedAt: "internal",
    donorRecordedAt: "internal",
    withdrawnAfterMoneyAt: "internal",
  },
  ManualInKindRecordResult: {
    id: "internal",
    inventoryLoaded: "internal",
  },
} as const;

export const relations = {} as const;
