// The closed-books gate, caps and timings the in-kind drain books QuickBooks entries with.
import type { QuickBooksClient } from "@checkin/quickbooks";

/** Days either side of a record's date a QuickBooks entry may be dated. */
export const MATCH_WINDOW_DAYS = 7;
// ponytail: fixed caps, as expense's; move to an org settings row when finance needs to tune them.
export const MAX_CREATES_PER_RUN = 25;
/** Consecutive failed posts after which a drain run stops: QuickBooks is likely down. */
export const MAX_CONSECUTIVE_FAILURES = 3;
/** A claim older than this belongs to a post that died between claim and settle; it may be taken over. */
export const STALE_CLAIM_MS = 10 * 60_000;
/** How far back the daily sweep looks for create attempts. */
export const SWEEP_DAYS = 30;

/** The books closing date as read for a run or an action: the date (null when none is set), or a failed read. */
export type CloseRead = { ok: true; date: string | null } | { ok: false; error: string };

export async function readCloseDate(client: QuickBooksClient): Promise<CloseRead> {
  try {
    return { ok: true, date: await client.bookCloseDate() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function shiftDate(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * What findOrCreate may do with one record. Nothing dated on or before the books closing date
 * is created; with no closing date, nothing dated before switch-on. Only a record created after
 * switch-on, or one finance asked to book, may be created. A failed closing-date read creates nothing.
 */
export function qbGate(
  date: string,
  close: CloseRead,
  onAt: Date | null,
  createdAt: Date,
  book: boolean,
): { closedThrough: string; mayCreate: boolean } {
  if (!close.ok) return { closedThrough: shiftDate(date, -1), mayCreate: false };
  const fallback = onAt ? shiftDate(onAt.toISOString().slice(0, 10), -1) : null;
  const closedThrough = close.date ?? fallback;
  if (closedThrough === null) return { closedThrough: shiftDate(date, -1), mayCreate: false };
  return { closedThrough, mayCreate: book || (onAt !== null && createdAt > onAt) };
}
