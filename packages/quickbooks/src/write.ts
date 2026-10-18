import { sumCents } from "@checkin/money";
import { QboRequestError, appKeyOf, assertAppKey, qboDate, type QuickBooksClient, type TxnWrite } from "./client";
import { billCandidate, depositCandidate, findMatch, purchaseCandidate, type MatchCandidate, type MatchRequest } from "./match";
import { CREATE } from "./internal";
import { TEST_VENDOR_PREFIX } from "./guard";

/** One lane record to find in QuickBooks, or create when the closed-books gate allows it. */
export interface FindOrCreateRequest extends Pick<MatchRequest, "window" | "claimedIds" | "excludedIds"> {
  /** What to create if nothing matches. Its TxnDate is the record's date and must sit inside `window`. */
  write: TxnWrite;
  /** The lane's idempotency key for this record. */
  key: string;
  /** The last closed date, YYYY-MM-DD: nothing dated on or before it is ever created. */
  closedThrough: string;
  /** True when the lane may create this record without asking finance. */
  mayCreate: boolean;
}

export type FindOrCreateResult =
  | { kind: "found"; id: string; via: "key" | "amount" }
  | { kind: "ambiguous"; ids: string[] }
  | { kind: "created"; id: string }
  | { kind: "failed"; error: string }
  /** Not found and dated in closed books, or refused by QuickBooks as closed (fault 6210): never created. */
  | { kind: "closed" }
  /** Not found and the lane may not create it on its own: finance books it or skips it. */
  | { kind: "needs-finance" };

/** QuickBooks' fault for a transaction dated in a closed period. */
const CLOSED_PERIOD_FAULT = "6210";

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
 * nothing; ambiguous → finance's queue; not found and dated on or before `closedThrough` →
 * closed; not found and `mayCreate` false → needs-finance; otherwise re-read the books closing
 * date, gate on the later of it and `closedThrough`, and create with the key. A create
 * QuickBooks refuses as closed is closed too. The created entry carries the key in its
 * PrivateNote and is dated inside the window, so a crash after QBO accepts it is found by key.
 */
export async function findOrCreate(client: QuickBooksClient, req: FindOrCreateRequest): Promise<FindOrCreateResult> {
  try {
    assertAppKey(req.key);
    const date = req.write.fields.txnDate;
    qboDate(date);
    qboDate(req.window.from);
    qboDate(req.window.to);
    qboDate(req.closedThrough);
    if (date < req.window.from || date > req.window.to) {
      throw new Error(`TxnDate ${date} is outside the match window ${req.window.from}..${req.window.to}`);
    }
    const match = findMatch(await candidates(client, req.write, req.window.from, req.window.to), {
      date,
      amountCents: sumCents(...req.write.fields.lines.map((l) => l.amountCents)),
      ref: matchRef(req.write),
      key: req.key,
      window: req.window,
      claimedIds: req.claimedIds,
      excludedIds: req.excludedIds,
    });
    if (match.kind !== "not-found") return match;
    if (date <= req.closedThrough) return { kind: "closed" };
    if (!req.mayCreate) return { kind: "needs-finance" };
    // Finance may have closed a period since the caller read the date.
    const closeDate = await client.bookCloseDate();
    if (closeDate !== null && date <= closeDate) return { kind: "closed" };
    try {
      return { kind: "created", id: (await client[CREATE](req.write, req.key)).Id };
    } catch (e) {
      if (e instanceof QboRequestError && e.codes.includes(CLOSED_PERIOD_FAULT)) return { kind: "closed" };
      throw e;
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
 * On the sandbox the name carries TEST_VENDOR_PREFIX, added only when missing.
 */
export async function createVendor(
  client: QuickBooksClient,
  name: string,
  key: string,
): Promise<{ kind: "found"; via: "name"; id: string; displayName: string } | { kind: "created"; id: string; displayName: string }> {
  const bare = name.trim();
  const trimmed = client.env === "sandbox" && !bare.startsWith(TEST_VENDOR_PREFIX) ? `${TEST_VENDOR_PREFIX}${bare}` : bare;
  const displayName = (await client.customerNamed(trimmed)) ? `${trimmed} (Vendor)` : trimmed;
  const existing = await client.vendorNamed(displayName);
  if (existing) return { kind: "found", via: "name", id: existing.Id, displayName };
  const created = await client[CREATE]({ entity: "Vendor", fields: { displayName } }, key);
  return { kind: "created", id: created.Id, displayName };
}
