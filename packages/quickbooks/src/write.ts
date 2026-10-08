import { sumCents } from "@inventory/money";
import { appKeyOf, assertAppKey, qboDate, type QuickBooksClient, type TxnWrite } from "./client";
import { billCandidate, depositCandidate, findMatch, purchaseCandidate, type MatchCandidate, type MatchRequest } from "./match";

/** One lane record to find in QuickBooks, or create when it is past the takeover line. */
export interface FindOrCreateRequest extends Pick<MatchRequest, "window" | "takeoverLine" | "claimedIds" | "excludedIds"> {
  /** What to create if nothing matches. Its TxnDate is the record's date and must sit inside `window`. */
  write: TxnWrite;
  /** The lane's idempotency key for this record. */
  key: string;
}

export type FindOrCreateResult =
  | { kind: "found"; id: string; via: "key" | "amount" }
  | { kind: "ambiguous"; ids: string[] }
  | { kind: "created"; id: string }
  | { kind: "failed"; error: string }
  /** Not found and on or before the takeover line: finance's queue, never created. */
  | { kind: "too-old" }
  /** Not found and the lane has no takeover line yet: nothing may be created. */
  | { kind: "no-line" };

async function candidates(client: QuickBooksClient, write: TxnWrite, from: string, to: string): Promise<MatchCandidate[]> {
  switch (write.entity) {
    case "Purchase":
      return (await client.purchasesBetween(from, to)).map((p) => purchaseCandidate(p, appKeyOf));
    case "Bill":
      return (await client.billsBetween(from, to)).map((b) => billCandidate(b, appKeyOf));
    case "Deposit":
      return (await client.depositsBetween(from, to)).map((d) => depositCandidate(d, appKeyOf));
  }
}

function matchRef(write: TxnWrite): string {
  switch (write.entity) {
    case "Purchase":
      return write.fields.accountId;
    case "Bill":
      return write.fields.vendorId;
    case "Deposit":
      return write.fields.depositToAccountId;
  }
}

/**
 * Match before create, stateless. Reads the record's window, then: found → link, post
 * nothing; ambiguous → finance's queue; not found after the line → create with the key;
 * before the line or with no line → never create. The created entry carries the key in its
 * PrivateNote and is dated inside the window, so a crash after QBO accepts it is found by key.
 */
export async function findOrCreate(client: QuickBooksClient, req: FindOrCreateRequest): Promise<FindOrCreateResult> {
  try {
    assertAppKey(req.key);
    const date = req.write.fields.txnDate;
    qboDate(date);
    qboDate(req.window.from);
    qboDate(req.window.to);
    if (date < req.window.from || date > req.window.to) {
      throw new Error(`TxnDate ${date} is outside the match window ${req.window.from}..${req.window.to}`);
    }
    const match = findMatch(await candidates(client, req.write, req.window.from, req.window.to), {
      date,
      amountCents: sumCents(...req.write.fields.lines.map((l) => l.amountCents)),
      ref: matchRef(req.write),
      key: req.key,
      window: req.window,
      takeoverLine: req.takeoverLine,
      claimedIds: req.claimedIds,
      excludedIds: req.excludedIds,
    });
    switch (match.kind) {
      case "found":
      case "ambiguous":
        return match;
      case "not-found-before-line":
        return { kind: "too-old" };
      case "not-found-no-line":
        return { kind: "no-line" };
      case "not-found-after-line":
        return { kind: "created", id: (await client.create(req.write, req.key)).Id };
    }
  } catch (e) {
    return { kind: "failed", error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Finance's "Create new" Vendor. A name already held by a Customer becomes "<name> (Vendor)".
 * An existing Vendor with the resulting name is returned as found via "name" (DisplayName is
 * unique, and this is how a retry after a crash recovers), never created twice. A Vendor
 * carries only its DisplayName, so a name hit is never told apart as the app's own creation.
 */
export async function createVendor(
  client: QuickBooksClient,
  name: string,
  key: string,
): Promise<{ kind: "found"; via: "name"; id: string; displayName: string } | { kind: "created"; id: string; displayName: string }> {
  const trimmed = name.trim();
  const displayName = (await client.customerNamed(trimmed)) ? `${trimmed} (Vendor)` : trimmed;
  const existing = await client.vendorNamed(displayName);
  if (existing) return { kind: "found", via: "name", id: existing.Id, displayName };
  const created = await client.create({ entity: "Vendor", fields: { displayName } }, key);
  return { kind: "created", id: created.Id, displayName };
}
