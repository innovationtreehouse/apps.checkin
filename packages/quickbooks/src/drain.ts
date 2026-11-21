// The caps' defaults, fixed timings and closed-books gate the QuickBooks drains post under, and the run loop that applies the caps.
import { shiftDate } from "./match";
import type { QuickBooksClient } from "./client";

/** The default days either side of a record's date a QuickBooks entry may be dated; each lane's settings hold its value. */
export const MATCH_WINDOW_DAYS = 7;
/** The widest match window a lane may set, and the reach of a read for an entry already linked, so narrowing never hides one. */
export const MAX_MATCH_WINDOW_DAYS = 30;
export const MAX_CREATES_PER_RUN = 25;
/** The most entries one run of any lane may create, whatever its setting says; a stored setting above it reads as it. */
export const MAX_CREATES_PER_RUN_CEILING = 100;
export const MAX_CREATES_PER_DAY = 50;
/** A claim older than this belongs to a post that died between claim and settle; it may be taken over. */
export const STALE_CLAIM_MS = 10 * 60_000;
/** How far back the daily sweep looks for create attempts. */
export const SWEEP_DAYS = 30;
/** Records a drift check reads per run; the slice moves each UTC day. */
export const MAX_DRIFT_CHECKS_PER_RUN = 25;

/**
 * The slice of `ids` to check today. The start moves by the cap each UTC day, so every entry
 * is checked within ceil(n / cap) days without storing a cursor.
 */
export function todaysSlice<T>(ids: T[], cap: number, now = new Date()): T[] {
  if (ids.length <= cap) return ids;
  const start = (Math.floor(now.getTime() / 86_400_000) * cap) % ids.length;
  return [...ids, ...ids].slice(start, start + cap);
}

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

/**
 * A run's hold on the host's posting slot. `renew` extends it before each record and before a
 * throttle's retry, answering false once another run holds it; a run that yields to a second
 * throttle sets `yielded` so the host queues the lane again.
 */
export interface PostingTurn {
  renew(): Promise<boolean>;
  yielded: boolean;
}

export interface DrainLane<R, O extends string> {
  /** Tallied per outcome as the run goes. */
  counts: Record<O | "posted", number>;
  /** One record's post; null ends the run. */
  post(row: R): Promise<O | null>;
  /**
   * The outcome of a post QuickBooks throttled, which leaves the record as it was. The first in a
   * run tries the record again once the client's pause ends; the second ends the run.
   */
  throttled?: O;
  /** The posting slot this run holds, when the host gave it one. */
  turn?: PostingTurn;
  /** Entries already created today, for a lane held to a daily limit. */
  createdToday?: number;
  /** Defaults to MAX_CREATES_PER_RUN; held to MAX_CREATES_PER_RUN_CEILING. */
  maxCreatesPerRun?: number;
  /** Defaults to MAX_CREATES_PER_DAY. */
  maxCreatesPerDay?: number;
}

/** Why a run ended before its last record, and how many records it left unposted. */
export interface DrainStop {
  by: "day" | "count" | "post" | "throttled" | "slot";
  remaining: number;
}

/** Posts each record in order until a cap, a second throttle, a lost slot or the lane ends the run. */
export async function runDrain<R, O extends string>(rows: readonly R[], lane: DrainLane<R, O>): Promise<DrainStop | null> {
  let throttled = false;
  for (const [i, row] of rows.entries()) {
    const remaining = rows.length - i;
    if (lane.createdToday !== undefined && lane.createdToday + lane.counts.posted >= (lane.maxCreatesPerDay ?? MAX_CREATES_PER_DAY)) return { by: "day", remaining };
    if (lane.counts.posted >= Math.min(lane.maxCreatesPerRun ?? MAX_CREATES_PER_RUN, MAX_CREATES_PER_RUN_CEILING)) return { by: "count", remaining };
    if (lane.turn && !(await lane.turn.renew())) return { by: "slot", remaining };
    let posted = await lane.post(row);
    if (posted === lane.throttled && !throttled) {
      throttled = true;
      lane.counts[posted]++;
      if (lane.turn && !(await lane.turn.renew())) return { by: "slot", remaining };
      posted = await lane.post(row);
    }
    if (posted === null) return { by: "post", remaining };
    lane.counts[posted]++;
    if (posted === lane.throttled) {
      if (lane.turn) lane.turn.yielded = true;
      return { by: "throttled", remaining };
    }
  }
  return null;
}
