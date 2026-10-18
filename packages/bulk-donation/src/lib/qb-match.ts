// Match state and match events for the QuickBooks drain (design §7); the drain is lib/qb-poster.ts.
import type { DbOrTx } from "../db";
import { recordEvent } from "../repositories/audit";
import type { AuditContext } from "../workflows/disbursement.actor";

export const QB_MATCH_STATE = {
  UNMATCHED: "UNMATCHED",
  MATCHED: "MATCHED",
  CREATED: "CREATED",
  AMBIGUOUS: "AMBIGUOUS",
  /** Not in QuickBooks and the drain may not create it (closed books, or before switch-on): finance books or skips it. */
  UNBOOKED: "UNBOOKED",
  /** Held exactly as UNBOOKED; this code never writes it. */
  BEFORE_LINE: "BEFORE_LINE",
  WAITING: "WAITING",
  POST_FAILED: "POST_FAILED",
  /** Claimed by a post whose QuickBooks call is in flight. */
  POSTING: "POSTING",
  /** Out of automatic retries, or over the per-run cap: finance's to resolve. */
  NEEDS_FINANCE: "NEEDS_FINANCE",
  /** Outside prod, not a TEST- disbursement: never sent. Re-checked each run. */
  NOT_TEST_DATA: "NOT_TEST_DATA",
  /** In prod, a TEST- disbursement: never sent. Re-checked each run. */
  TEST_DATA_REFUSED: "TEST_DATA_REFUSED",
  /** The held deposit is gone or changed in QuickBooks: finance's to resolve, never matched again automatically. */
  DRIFT: "DRIFT",
  /** Finance settled it outside the app, with a reason: never posted or matched again. */
  DISMISSED: "DISMISSED",
} as const;
export type QbMatchState = (typeof QB_MATCH_STATE)[keyof typeof QB_MATCH_STATE];

/** The append-only workflow event the drain writes whenever a record is matched to a QuickBooks entry. */
export const QB_MATCHED_EVENT = "QB_MATCHED";

/** Record a Benevity disbursement matched to a hand-booked QuickBooks entry, in the caller's transaction. */
export async function recordQbMatched(
  handle: DbOrTx,
  orgId: string,
  match: { disbursementId: string; disbursementDate: string | null; qbTxnId: string },
  audit: AuditContext,
): Promise<void> {
  await recordEvent(handle, {
    orgId,
    disbursementId: match.disbursementId,
    entityType: "disbursement",
    entityId: match.disbursementId,
    eventType: QB_MATCHED_EVENT,
    actorUserId: audit.actorUserId,
    actorUsername: audit.actorUsername,
    correlationId: audit.correlationId,
    payload: { qbTxnId: match.qbTxnId, disbursementDate: match.disbursementDate },
  });
}
