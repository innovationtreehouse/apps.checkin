import { dollarsToCents } from "@inventory/money";
import { qboDate } from "./client";
import type { QboBill, QboDeposit, QboPurchase } from "./types";

/** One QuickBooks entry offered for a match, reduced to what matching compares. */
export interface MatchCandidate {
  id: string;
  date: string; // YYYY-MM-DD
  amountCents: number;
  /** The account (Deposit, Purchase) or vendor (Bill) the entry is booked to. */
  ref?: string;
  /** The idempotency key the app wrote into the entry; absent on hand-booked entries. */
  appKey?: string;
}

/** One of the lane's own unmatched records, plus the lane state matching needs. */
export interface MatchRequest {
  date: string;
  amountCents: number;
  /** When set, a hand entry must be booked to this account or vendor. */
  ref?: string;
  /** The caller's idempotency key for this record. */
  key: string;
  /** Inclusive YYYY-MM-DD range a hand entry's date must fall in. */
  window: { from: string; to: string };
  /** From takeoverLine(); null means no line, and nothing may be created. */
  takeoverLine: string | null;
  /** Entries other records of the lane already hold. */
  claimedIds: ReadonlySet<string>;
  /** Entries finance excluded from matching. */
  excludedIds: ReadonlySet<string>;
}

export type MatchResult =
  | { kind: "found"; id: string; via: "key" | "amount" }
  | { kind: "ambiguous"; ids: string[] }
  | { kind: "not-found-after-line" }
  | { kind: "not-found-before-line" }
  | { kind: "not-found-no-line" };

/**
 * The "find" half of match-before-create. Stateless: the caller supplies the
 * candidates (from a windowed reader) and its claimed and excluded ids.
 */
export function findMatch(candidates: readonly MatchCandidate[], req: MatchRequest): MatchResult {
  qboDate(req.date);
  qboDate(req.window.from);
  qboDate(req.window.to);
  if (req.window.from > req.window.to) throw new Error(`Match window is reversed: ${req.window.from} > ${req.window.to}`);
  if (req.takeoverLine !== null) qboDate(req.takeoverLine);

  // A key hit is the app's own creation; a hit finance excluded or another record holds goes to a person, never a second booking.
  const own = candidates.filter((c) => c.appKey === req.key);
  if (own.length === 1 && !req.excludedIds.has(own[0].id) && !req.claimedIds.has(own[0].id)) {
    return { kind: "found", id: own[0].id, via: "key" };
  }
  if (own.length > 0) return { kind: "ambiguous", ids: own.map((c) => c.id) };

  const hand = candidates.filter(
    (c) =>
      c.appKey === undefined &&
      !req.excludedIds.has(c.id) &&
      !req.claimedIds.has(c.id) &&
      c.amountCents === req.amountCents &&
      c.date >= req.window.from &&
      c.date <= req.window.to &&
      (req.ref === undefined || c.ref === req.ref),
  );
  if (hand.length === 1) return { kind: "found", id: hand[0].id, via: "amount" };
  if (hand.length > 1) return { kind: "ambiguous", ids: hand.map((c) => c.id) };

  if (req.takeoverLine === null) return { kind: "not-found-no-line" };
  return req.date > req.takeoverLine ? { kind: "not-found-after-line" } : { kind: "not-found-before-line" };
}

/** A lane record's link to QuickBooks: "hand" if the entry was hand-booked, "app" if the app created it. */
export interface TiedRecord {
  date: string;
  qbOrigin: "hand" | "app" | null;
}

/** The date of the newest record tied to a hand-booked entry; null (create nothing) when there is none. */
export function takeoverLine(records: Iterable<TiedRecord>): string | null {
  let line: string | null = null;
  for (const r of records) {
    qboDate(r.date);
    if (r.qbOrigin === "hand" && (line === null || r.date > line)) line = r.date;
  }
  return line;
}

type AppKeyOf<T> = (entry: T) => string | undefined;

export function depositCandidate(d: QboDeposit, appKeyOf?: AppKeyOf<QboDeposit>): MatchCandidate {
  return { id: d.Id, date: d.TxnDate, amountCents: dollarsToCents(d.TotalAmt), ref: d.DepositToAccountRef?.value, appKey: appKeyOf?.(d) };
}

export function purchaseCandidate(p: QboPurchase, appKeyOf?: AppKeyOf<QboPurchase>): MatchCandidate {
  return { id: p.Id, date: p.TxnDate, amountCents: dollarsToCents(p.TotalAmt), ref: p.AccountRef?.value, appKey: appKeyOf?.(p) };
}

export function billCandidate(b: QboBill, appKeyOf?: AppKeyOf<QboBill>): MatchCandidate {
  return { id: b.Id, date: b.TxnDate, amountCents: dollarsToCents(b.TotalAmt), ref: b.VendorRef?.value, appKey: appKeyOf?.(b) };
}
