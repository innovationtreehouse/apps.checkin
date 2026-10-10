// Pre-seated state for the QuickBooks drain (design §7). The drain itself lands in D.
import { DisbursementPayloadV1 } from "@inventory/donations";
import type { DbOrTx } from "../db";

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

/**
 * A stream's takeover line: the date of its newest MATCHED record (tied to an entry the app
 * did not create). CREATED never moves it. Dates are YYYY-MM-DD, compared as strings. No MATCHED record means no line: create nothing.
 */
export function deriveTakeoverLine(records: Array<{ date: string | null; qbMatchState: string }>): string | null {
  let line: string | null = null;
  for (const r of records) {
    if (r.qbMatchState === QB_MATCH_STATE.MATCHED && r.date && (line === null || r.date > line)) line = r.date;
  }
  return line;
}

/** The Benevity stream's line, dated by each disbursement's date. */
export async function benevityTakeoverLine(handle: DbOrTx, orgId: string): Promise<string | null> {
  // ponytail: reads every MATCHED event and parses its payload; add a date column if volume grows past hundreds a year.
  const rows = await handle.disbursementEvent.findMany({
    where: { orgId, qbMatchState: QB_MATCH_STATE.MATCHED },
    select: { payload: true, qbMatchState: true },
  });
  return deriveTakeoverLine(
    rows.map((r) => ({ date: DisbursementPayloadV1.parse(JSON.parse(r.payload)).disbursementDate, qbMatchState: r.qbMatchState })),
  );
}
