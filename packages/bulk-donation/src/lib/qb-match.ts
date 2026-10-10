// Pre-seated state for the QuickBooks drain (design §7). The drain itself lands in D.
import { z } from "zod";
import type { DbOrTx } from "../db";
import { recordEvent } from "../repositories/audit";
import type { AuditContext } from "../workflows/disbursement.actor";

export const QB_MATCH_STATE = {
  UNMATCHED: "UNMATCHED",
  MATCHED: "MATCHED",
  CREATED: "CREATED",
  AMBIGUOUS: "AMBIGUOUS",
  BEFORE_LINE: "BEFORE_LINE",
  WAITING: "WAITING",
  POST_FAILED: "POST_FAILED",
} as const;
export type QbMatchState = (typeof QB_MATCH_STATE)[keyof typeof QB_MATCH_STATE];

/** The append-only workflow event the drain writes whenever a record is matched to a QuickBooks entry. */
export const QB_MATCHED_EVENT = "QB_MATCHED";

/**
 * A stream's takeover line: the newest date any of its records was ever matched to an entry
 * the app did not create. It reads the append-only match events, never a record's current
 * state, so an un-match or re-pick cannot move it back. CREATED writes no match event, so it
 * never moves the line. Dates are YYYY-MM-DD, compared as strings. No match means no line:
 * create nothing.
 */
export function deriveTakeoverLine(matchedDates: ReadonlyArray<string | null>): string | null {
  let line: string | null = null;
  for (const date of matchedDates) {
    if (date && (line === null || date > line)) line = date;
  }
  return line;
}

const matchedPayload = z.object({ disbursementDate: z.string().nullable() });

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

/** The Benevity stream's line, from every match ever recorded. */
export async function benevityTakeoverLine(handle: DbOrTx, orgId: string): Promise<string | null> {
  const rows = await handle.workflowEvent.findMany({
    where: { orgId, entityType: "disbursement", eventType: QB_MATCHED_EVENT },
    select: { payload: true },
  });
  return deriveTakeoverLine(rows.map((r) => matchedPayload.parse(JSON.parse(r.payload ?? "{}")).disbursementDate));
}
