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
} as const;

export const relations = {} as const;
