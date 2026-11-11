// The QuickBooks match state the in-kind drain keeps on each record.

export const QB_MATCH_STATE = {
  UNMATCHED: "UNMATCHED",
  MATCHED: "MATCHED",
  CREATED: "CREATED",
  AMBIGUOUS: "AMBIGUOUS",
  /** Not in QuickBooks and the drain may not create it (closed books, or before switch-on): finance books or skips it. */
  UNBOOKED: "UNBOOKED",
  WAITING: "WAITING",
  POST_FAILED: "POST_FAILED",
  /** Claimed by a post whose QuickBooks call is in flight. */
  POSTING: "POSTING",
  /** Out of automatic retries, or over the per-run cap: finance's to resolve. */
  NEEDS_FINANCE: "NEEDS_FINANCE",
  /** A gift of goods with a line no account rule or hand-set account books: each run tries again, and finance may set the account. */
  NEEDS_ACCOUNT: "NEEDS_ACCOUNT",
  /** Outside prod, not a TEST- disbursement: never sent. Re-checked each run. */
  NOT_TEST_DATA: "NOT_TEST_DATA",
  /** In prod, a TEST- disbursement: never sent. Re-checked each run. */
  TEST_DATA_REFUSED: "TEST_DATA_REFUSED",
  /** A held entry is gone or changed in QuickBooks: finance matches it again or skips it, never automatically. */
  DRIFT: "DRIFT",
  /** Finance settled it outside the app, with a reason: never posted or matched again. */
  DISMISSED: "DISMISSED",
} as const;
export type QbMatchState = (typeof QB_MATCH_STATE)[keyof typeof QB_MATCH_STATE];

