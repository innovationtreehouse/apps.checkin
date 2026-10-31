import { sumCents } from "@checkin/money";
import { QboRequestError, appKeyOf, assertAppKey, qboDate, type JournalEntryFields, type JournalLine, type QuickBooksClient, type TxnWrite } from "./client";
import { billCandidate, depositCandidate, findMatch, journalCandidate, purchaseCandidate, type MatchCandidate, type MatchRequest } from "./match";
import { CREATE, CREATE_JOURNAL } from "./internal";
import type { BooksMapRole } from "./booksMap";
import { TEST_PREFIX } from "./guard";

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
  /** `txnDate` is the matched entry's date, from the read that matched it. */
  | { kind: "found"; id: string; via: "key" | "amount"; txnDate: string }
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

type MatchThenCreate = Pick<MatchRequest, "date" | "amountCents" | "ref" | "key" | "window" | "claimedIds" | "excludedIds"> & {
  closedThrough: string;
  mayCreate: boolean;
};

/**
 * The shared match-before-create and closed-books gate. Found → link, post nothing; ambiguous →
 * finance's queue; not found and dated on or before `closedThrough` → closed; not found and
 * `mayCreate` false → needs-finance; otherwise re-read the books closing date, gate on the later
 * of it and `closedThrough`, and create. A create QuickBooks refuses as closed is closed too.
 */
async function matchThenCreate(
  client: QuickBooksClient,
  req: MatchThenCreate,
  read: readonly MatchCandidate[],
  create: () => Promise<{ Id: string }>,
): Promise<FindOrCreateResult> {
  const match = findMatch(read, req);
  if (match.kind === "found") {
    const hit = read.find((c) => c.id === match.id);
    if (!hit) throw new Error(`matched entry ${match.id} is not in the read`);
    return { ...match, txnDate: hit.date };
  }
  if (match.kind === "ambiguous") return match;
  if (req.date <= req.closedThrough) return { kind: "closed" };
  if (!req.mayCreate) return { kind: "needs-finance" };
  // Finance may have closed a period since the caller read the date.
  const closeDate = await client.bookCloseDate();
  if (closeDate !== null && req.date <= closeDate) return { kind: "closed" };
  try {
    return { kind: "created", id: (await create()).Id };
  } catch (e) {
    if (e instanceof QboRequestError && e.codes.includes(CLOSED_PERIOD_FAULT)) return { kind: "closed" };
    throw e;
  }
}

function checkDates(date: string, req: { window: { from: string; to: string }; closedThrough: string }): void {
  qboDate(date);
  qboDate(req.window.from);
  qboDate(req.window.to);
  qboDate(req.closedThrough);
  if (date < req.window.from || date > req.window.to) {
    throw new Error(`TxnDate ${date} is outside the match window ${req.window.from}..${req.window.to}`);
  }
}

const failed = (e: unknown): FindOrCreateResult => ({ kind: "failed", error: e instanceof Error ? e.message : String(e) });

/**
 * Match before create, stateless, through the shared gate. The created entry carries the key in
 * its PrivateNote and is dated inside the window, so a crash after QBO accepts it is found by key.
 */
export async function findOrCreate(client: QuickBooksClient, req: FindOrCreateRequest): Promise<FindOrCreateResult> {
  try {
    assertAppKey(req.key);
    const date = req.write.fields.txnDate;
    checkDates(date, req);
    const read = await candidates(client, req.write, req.window.from, req.window.to);
    const amountCents = sumCents(...req.write.fields.lines.map((l) => l.amountCents));
    return await matchThenCreate(client, { ...req, date, amountCents, ref: matchRef(req.write) }, read, () => client[CREATE](req.write, req.key));
  } catch (e) {
    return failed(e);
  }
}

/** The books-map roles an in-kind journal entry may credit, and those it may debit. */
export const IN_KIND_CREDIT_ROLES: readonly BooksMapRole[] = ["INKIND_INCOME"];
export const IN_KIND_DEBIT_ROLES: readonly BooksMapRole[] = ["INKIND_EXPENSE", "FIXED_ASSETS"];

/** One line of an in-kind gift's journal entry, by books-map role; the role's account is resolved here. */
export interface InKindJournalLine {
  postingType: "Debit" | "Credit";
  role: BooksMapRole;
  amountCents: number;
  classId?: string;
  description?: string;
}

export interface InKindJournalRequest extends Pick<MatchRequest, "window" | "claimedIds"> {
  txnDate: string;
  lines: InKindJournalLine[];
  memo?: string;
  key: string;
  closedThrough: string;
  mayCreate: boolean;
  /** The books map's role → account ids, as read for this run. */
  accounts: Partial<Record<BooksMapRole, string>>;
}

/**
 * The only way the app creates a JournalEntry: one in-kind gift. Credits go only to in-kind
 * income and debits only to in-kind expense or fixed assets, every amount positive and the entry
 * balanced, or it throws before reading QuickBooks. Matching is by the app's key alone: a hand
 * entry of the same amount is never taken as the gift's.
 */
export async function findOrCreateInKindJournal(client: QuickBooksClient, req: InKindJournalRequest): Promise<FindOrCreateResult> {
  const fields: JournalEntryFields = { txnDate: req.txnDate, memo: req.memo, lines: req.lines.map((l) => inKindLine(l, req.accounts)) };
  const total = (side: JournalLine["postingType"]) => sumCents(...fields.lines.filter((l) => l.postingType === side).map((l) => l.amountCents));
  if (fields.lines.some((l) => !Number.isSafeInteger(l.amountCents) || l.amountCents <= 0)) throw new Error("In-kind journal amounts must be positive whole cents");
  if (total("Credit") === 0 || total("Debit") !== total("Credit")) throw new Error("In-kind journal entry is not balanced");
  try {
    assertAppKey(req.key);
    checkDates(req.txnDate, req);
    const read = (await client.journalEntriesBetween(req.window.from, req.window.to)).map((j) => journalCandidate(j, appKeyOf)).filter((c) => c.appKey !== undefined);
    return await matchThenCreate(
      client,
      { ...req, date: req.txnDate, amountCents: total("Debit"), excludedIds: new Set() },
      read,
      () => client[CREATE_JOURNAL](fields, req.key),
    );
  } catch (e) {
    return failed(e);
  }
}

function inKindLine(l: InKindJournalLine, accounts: InKindJournalRequest["accounts"]): JournalLine {
  const allowed = l.postingType === "Credit" ? IN_KIND_CREDIT_ROLES : l.postingType === "Debit" ? IN_KIND_DEBIT_ROLES : [];
  if (!allowed.includes(l.role)) throw new Error(`An in-kind journal entry may not ${String(l.postingType).toLowerCase()} ${l.role}`);
  const accountId = accounts[l.role];
  if (!accountId) throw new Error(`The books map has no account for ${l.role}`);
  return { postingType: l.postingType, amountCents: l.amountCents, accountId, classId: l.classId, description: l.description };
}

/**
 * Finance's "Create new" Vendor. A name already held by a Customer becomes "<name> (Vendor)".
 * An existing Vendor with the resulting name is returned as found via "name" (DisplayName is
 * unique, and this is how a retry after a crash recovers), never created twice. A Vendor
 * carries only its DisplayName, so a name hit is never told apart as the app's own creation.
 * On the sandbox the name carries TEST_PREFIX, added only when missing.
 */
export async function createVendor(
  client: QuickBooksClient,
  name: string,
  key: string,
): Promise<{ kind: "found"; via: "name"; id: string; displayName: string } | { kind: "created"; id: string; displayName: string }> {
  const bare = name.trim();
  const trimmed = client.env === "sandbox" && !bare.startsWith(TEST_PREFIX) ? `${TEST_PREFIX}${bare}` : bare;
  const displayName = (await client.customerNamed(trimmed)) ? `${trimmed} (Vendor)` : trimmed;
  const existing = await client.vendorNamed(displayName);
  if (existing) return { kind: "found", via: "name", id: existing.Id, displayName };
  const created = await client[CREATE]({ entity: "Vendor", fields: { displayName } }, key);
  return { kind: "created", id: created.Id, displayName };
}
