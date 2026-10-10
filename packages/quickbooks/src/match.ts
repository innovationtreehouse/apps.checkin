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
  /** The idempotency key the app wrote into the entry; absent on hand-booked entries. Space-joined when the entry carries several. */
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
  /** Inclusive YYYY-MM-DD range every hit's date must fall in; callers pad it with a grace on both sides. */
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
 *
 * Every hit, key or hand, must have the exact amount, the request's ref when set, and a
 * date inside `req.window`. QuickBooks dates often sit a day or two off the record's, so
 * callers should pad the window with a grace on both sides; this function adds none.
 * A key hit that fails any check, an entry carrying the key beside another key, or a
 * matching entry carrying another record's key goes to a person: a copied or edited memo must never be taken as the app's own entry,
 * and must never fall through to a create.
 */
export function findMatch(candidates: readonly MatchCandidate[], req: MatchRequest): MatchResult {
  qboDate(req.date);
  qboDate(req.window.from);
  qboDate(req.window.to);
  if (req.window.from > req.window.to) throw new Error(`Match window is reversed: ${req.window.from} > ${req.window.to}`);
  if (req.takeoverLine !== null) qboDate(req.takeoverLine);

  const fits = (c: MatchCandidate) =>
    c.amountCents === req.amountCents &&
    c.date >= req.window.from &&
    c.date <= req.window.to &&
    (req.ref === undefined || c.ref === req.ref);
  const free = (c: MatchCandidate) => !req.excludedIds.has(c.id) && !req.claimedIds.has(c.id);

  const own = candidates.filter((c) => c.appKey?.split(" ").includes(req.key));
  if (own.length === 1 && own[0].appKey === req.key && fits(own[0]) && free(own[0])) return { kind: "found", id: own[0].id, via: "key" };
  if (own.length > 0) return { kind: "ambiguous", ids: own.map((c) => c.id) };

  const hits = candidates.filter((c) => fits(c) && free(c));
  const hand = hits.filter((c) => c.appKey === undefined);
  if (hand.length === 1 && hits.length === 1) return { kind: "found", id: hand[0].id, via: "amount" };
  if (hits.length > 0) return { kind: "ambiguous", ids: hits.map((c) => c.id) };

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
