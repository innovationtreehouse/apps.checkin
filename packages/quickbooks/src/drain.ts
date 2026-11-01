// The caps' defaults, fixed timings and closed-books gate the QuickBooks drains post under, and the run loop that applies the caps.
import { shiftDate } from "./match";
import type { QuickBooksClient } from "./client";

/** The default days either side of a record's date a QuickBooks entry may be dated; each lane's settings hold its value. */
export const MATCH_WINDOW_DAYS = 7;
/** The widest match window a lane may set, and the reach of a read for an entry already linked, so narrowing never hides one. */
export const MAX_MATCH_WINDOW_DAYS = 30;
export const MAX_CREATES_PER_RUN = 25;
export const MAX_CREATES_PER_DAY = 50;
/** Failed posts before the drain stops retrying and hands the record to finance. */
export const MAX_POST_ATTEMPTS = 5;
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

/** What findOrCreate may do with one record. */
export interface PostGate {
  /** The last closed date, YYYY-MM-DD: nothing dated on or before it is created. */
  closedThrough: string;
  mayCreate: boolean;
}

/**
 * Nothing dated on or before the books closing date is created; with no closing date, nothing
 * dated before switch-on. Only a record that arrived after switch-on, or one finance asked to
 * book, may be created. A failed closing-date read, or neither date, creates nothing.
 */
export function qbGate(date: string, close: CloseRead, onAt: Date | null, arrivedAt: Date, book: boolean): PostGate {
  const never = { closedThrough: shiftDate(date, -1), mayCreate: false };
  if (!close.ok) return never;
  const closedThrough = close.date ?? (onAt ? shiftDate(onAt.toISOString().slice(0, 10), -1) : null);
  if (closedThrough === null) return never;
  return { closedThrough, mayCreate: book || (onAt !== null && arrivedAt > onAt) };
}

export interface DrainLane<R, O extends string> {
  /** Tallied per outcome as the run goes. */
  counts: Record<O | "posted", number>;
  /** One record's post; null ends the run. */
  post(row: R): Promise<O | null>;
  /** The outcomes that count toward MAX_CONSECUTIVE_FAILURES; any other resets the streak. */
  failures: readonly O[];
  /** Outcomes that made no QuickBooks call, so they leave the streak as it is. */
  noCall?: readonly O[];
  /** Entries already created today, for a lane held to a daily limit. */
  createdToday?: number;
  /** Defaults to MAX_CREATES_PER_RUN. */
  maxCreatesPerRun?: number;
  /** Defaults to MAX_CREATES_PER_DAY. */
  maxCreatesPerDay?: number;
}

/** Why a run ended before its last record, and how many records it left unposted. */
export type DrainStop = { by: "day" | "count" | "failures" | "post"; remaining: number };

/** Posts each record in order until a cap, a failure streak or the lane ends the run. */
export async function runDrain<R, O extends string>(rows: readonly R[], lane: DrainLane<R, O>): Promise<DrainStop | null> {
  let failuresInARow = 0;
  for (const [i, row] of rows.entries()) {
    const remaining = rows.length - i;
    if (lane.createdToday !== undefined && lane.createdToday + lane.counts.posted >= (lane.maxCreatesPerDay ?? MAX_CREATES_PER_DAY)) return { by: "day", remaining };
    if (lane.counts.posted >= (lane.maxCreatesPerRun ?? MAX_CREATES_PER_RUN)) return { by: "count", remaining };
    const outcome = await lane.post(row);
    if (outcome === null) return { by: "post", remaining };
    lane.counts[outcome]++;
    if (!lane.noCall?.includes(outcome)) failuresInARow = lane.failures.includes(outcome) ? failuresInARow + 1 : 0;
    if (failuresInARow >= MAX_CONSECUTIVE_FAILURES) return { by: "failures", remaining: remaining - 1 };
  }
  return null;
}
