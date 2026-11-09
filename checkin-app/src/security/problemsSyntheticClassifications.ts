/**
 * Non-Prisma response models the System Status Problems list ships through
 * handler() (the catalogSyntheticClassifications.ts pattern).
 *
 * ProblemRetryResult — one item's outcome from Retry or Retry all (POST
 * /api/system-status/problems/retry): the step, the stuck row's id as the
 * caller sent it, and whether the step ran. All `internal`. No error text: a
 * library's error can be `personal`, and the item's own page shows it under
 * that page's access.
 *
 * Hand-authored, not generated: this describes an API response, not a table.
 * This is a security-boundary artifact — changes ship in a boundary PR.
 */
export const classifications = {
  ProblemRetryResult: {
    step: "internal",
    id: "internal",
    ok: "internal",
  },
} as const;

export const relations = {} as const;
