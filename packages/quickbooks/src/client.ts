import { createHash } from "node:crypto";
import { centsToDollars } from "@checkin/money";
import { CREATE, CREATE_JOURNAL } from "./internal";
import { TEST_NOTE_MARKER, assertPayloadMarked } from "./guard";
import type {
  AccessTokenSource,
  QboAccount,
  QboBill,
  QboBillPayment,
  QboClass,
  QboCustomer,
  QboDeposit,
  QboEnv,
  QboJournalEntry,
  QboPreferences,
  QboPurchase,
  QboRealm,
  QboVendor,
  GroundTruthRecord,
} from "./types";

const MINOR_VERSION = "70";
const PAGE_SIZE = 1000; // QBO's MAXRESULTS ceiling
/** Widest window a reader accepts, so a reader can never walk QuickBooks history. */
export const MAX_WINDOW_DAYS = 93;
const DAY_MS = 86_400_000;
/** How far ahead of QuickBooks' clock the app's may run before createdSince misses an entry. */
const CREATED_SINCE_MARGIN_MS = 3_600_000;
const CREATED_SINCE_MAX_PAGES = 10;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRY_AFTER_S = 10;

/** The numeric fault codes of a QBO Fault body, or none; never the fault's free text. */
async function faultCodes(res: Response): Promise<string[]> {
  try {
    const body = (await res.json()) as { Fault?: { Error?: { code?: unknown }[] } };
    return (body.Fault?.Error ?? []).map((e) => e.code).filter((c): c is string => typeof c === "string" && /^\d+$/.test(c));
  } catch {
    return [];
  }
}

/** A failed QBO request. The message names the status, intuit_tid and fault codes only. */
export class QboRequestError extends Error {
  readonly codes: readonly string[];

  constructor(message: string, codes: readonly string[]) {
    super(codes.length ? `${message}: codes ${codes.join(",")}` : message);
    this.name = "QboRequestError";
    this.codes = codes;
  }
}

function apiBase(env: QboEnv): string {
  return env === "production"
    ? "https://quickbooks.api.intuit.com"
    : "https://sandbox-quickbooks.api.intuit.com";
}

export function qboEnvFromEnv(): QboEnv {
  const env = process.env.QBO_ENVIRONMENT ?? "sandbox";
  if (env !== "sandbox" && env !== "production") throw new Error(`QBO_ENVIRONMENT must be sandbox or production, got "${env}"`);
  return env;
}

/** QBO_ENVIRONMENT + QBO_REALM_ID, checked by assertRealmAllowed. */
export function qboRealmFromEnv(): QboRealm {
  const realmId = process.env.QBO_REALM_ID;
  if (!realmId) throw new Error("QBO_REALM_ID must be set");
  const realm = { env: qboEnvFromEnv(), realmId };
  assertRealmAllowed(realm);
  return realm;
}

/** The production company is reachable only from CHECKIN_ENV=prod; anything else, unset included, fails closed. */
export function assertRealmAllowed(realm: QboRealm): void {
  if (realm.env === "production" && process.env.CHECKIN_ENV !== "prod") {
    throw new Error("QBO production realm requires CHECKIN_ENV=prod");
  }
  if (!/^\d+$/.test(realm.realmId)) throw new Error("QBO realmId must be numeric");
}

/** A QBO query string literal: backslash-escapes `\` and `'`, rejects control characters. */
export function qboString(value: string): string {
  if ([...value].some((c) => c < " " || c === "\x7f")) throw new Error("QBO query value contains a control character");
  return `'${value.replace(/[\\']/g, (c) => `\\${c}`)}'`;
}

function parseDate(value: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (!d || d.toISOString().slice(0, 10) !== value) throw new Error(`Invalid QBO date "${value}" (want YYYY-MM-DD)`);
  return d;
}

/** A YYYY-MM-DD calendar date as a QBO query literal. */
export function qboDate(value: string): string {
  parseDate(value);
  return `'${value}'`;
}

/**
 * The only entities the generic writer may create. A reimbursement is a Bill the app never pays;
 * BillPayment, Payment, JournalEntry and every other entity are refused. An in-kind gift's
 * JournalEntry has its own narrow path, findOrCreateInKindJournal.
 */
export const WRITABLE_ENTITIES = ["Purchase", "Bill", "Deposit", "Vendor"] as const;
export type WritableEntity = (typeof WRITABLE_ENTITIES)[number];

/** One booked line: integer cents to an account, optionally a Class (a bucket's QB ref). */
export interface WriteLine {
  amountCents: number;
  accountId: string;
  classId?: string;
  description?: string;
}

/** A card or cash expense, paid from `accountId`. A Check is never written. */
export interface PurchaseFields {
  txnDate: string;
  paymentType: "Cash" | "CreditCard";
  accountId: string;
  vendorId?: string;
  lines: WriteLine[];
  memo?: string;
}

/** A Bill to `vendorId` (a reimbursement). The app creates it and never pays it. */
export interface BillFields {
  txnDate: string;
  vendorId: string;
  dueDate?: string;
  lines: WriteLine[];
  memo?: string;
}

export interface DepositFields {
  txnDate: string;
  depositToAccountId: string;
  lines: WriteLine[];
  memo?: string;
}

/** One JournalEntry line: a debit or credit of positive integer cents to an account. */
export interface JournalLine {
  postingType: "Debit" | "Credit";
  amountCents: number;
  accountId: string;
  classId?: string;
  description?: string;
}

export interface JournalEntryFields {
  txnDate: string;
  lines: JournalLine[];
  memo?: string;
}

export interface VendorFields {
  displayName: string;
}

export type TxnWrite =
  | { entity: "Purchase"; fields: PurchaseFields }
  | { entity: "Bill"; fields: BillFields }
  | { entity: "Deposit"; fields: DepositFields };

export type WriteRequest = TxnWrite | { entity: "Vendor"; fields: VendorFields };

const KEY_PATTERN = /^[A-Za-z0-9._:/-]{1,50}$/;
const KEY_MARKER = /\[checkin:([A-Za-z0-9._:/-]{1,50})\]/;
const KEY_MARKERS = new RegExp(KEY_MARKER.source, "g");
const MAX_PRIVATE_NOTE = 4000;

const LANE_PATTERN = /^[a-z][a-z0-9-]{0,14}$/;
const HASH_HEX_CHARS = 32; // 128 bits of sha256

/**
 * The only way a lane builds its idempotency key: `<lane>:<sourceId>` when that fits
 * KEY_PATTERN, else `<lane>:h:<128-bit sha256 hex>` of it. Deterministic, so a retry
 * sends the same key. The 50-char cap is QBO's `requestid` limit as documented, not
 * verified live; this is the one place to change it.
 */
export function qbKey(lane: string, sourceId: string): string {
  if (!LANE_PATTERN.test(lane)) throw new Error(`QBO key lane must match ${LANE_PATTERN}, got "${lane}"`);
  if (!sourceId) throw new Error("QBO key sourceId must not be empty");
  const plain = `${lane}:${sourceId}`;
  if (KEY_PATTERN.test(plain)) return plain;
  return `${lane}:h:${createHash("sha256").update(plain).digest("hex").slice(0, HASH_HEX_CHARS)}`;
}

/** The caller's idempotency key (from qbKey), sent as QBO `requestid` and written into a created transaction's PrivateNote. */
export function assertAppKey(key: string): void {
  if (!KEY_PATTERN.test(key)) throw new Error(`QBO app key must be 1-50 of [A-Za-z0-9._:/-], got "${key}"`);
}

/**
 * The app key a created transaction carries in its PrivateNote; undefined on hand-booked entries.
 * A well-formed marker counts anywhere in the note. Two different keys come back space-joined,
 * which equals no key because the key charset has no space, so findMatch sends the entry to a person.
 */
export function appKeyOf(entry: { PrivateNote?: string }): string | undefined {
  const keys = new Set(Array.from((entry.PrivateNote ?? "").matchAll(KEY_MARKERS), (m) => m[1]));
  return keys.size ? [...keys].join(" ") : undefined;
}

function privateNote(memo: string | undefined, key: string, env: QboEnv): string {
  if (memo !== undefined && KEY_MARKER.test(memo)) throw new Error("QBO memo must not carry an app key marker");
  const tagged = env === "sandbox" ? `${TEST_NOTE_MARKER} [checkin:${key}]` : `[checkin:${key}]`;
  const note = memo ? `${memo}\n${tagged}` : tagged;
  if (note.length > MAX_PRIVATE_NOTE) throw new Error(`QBO PrivateNote is ${note.length} chars; the limit is ${MAX_PRIVATE_NOTE}`);
  return note;
}

function ref(id: string): { value: string } {
  if (!/^\d+$/.test(id)) throw new Error(`QBO ref id must be numeric, got "${id}"`);
  return { value: id };
}

function lines(rows: WriteLine[], detailType: "AccountBasedExpenseLineDetail" | "DepositLineDetail") {
  if (rows.length === 0) throw new Error("QBO transaction needs at least one line");
  return rows.map((l) => ({
    Amount: centsToDollars(l.amountCents),
    DetailType: detailType,
    [detailType]: { AccountRef: ref(l.accountId), ...(l.classId !== undefined && { ClassRef: ref(l.classId) }) },
    ...(l.description !== undefined && { Description: l.description }),
  }));
}

/** The request body: only the listed fields of each entity, so no Id, SyncToken or sparse update can be sent. */
function writeBody(req: WriteRequest, key: string, env: QboEnv): Record<string, unknown> {
  switch (req.entity) {
    case "Purchase": {
      const f = req.fields;
      if (f.paymentType !== "Cash" && f.paymentType !== "CreditCard") {
        throw new Error(`QBO Purchase PaymentType must be Cash or CreditCard, got "${String(f.paymentType)}"`);
      }
      parseDate(f.txnDate);
      return {
        TxnDate: f.txnDate,
        PaymentType: f.paymentType,
        AccountRef: ref(f.accountId),
        ...(f.vendorId !== undefined && { EntityRef: { ...ref(f.vendorId), type: "Vendor" } }),
        Line: lines(f.lines, "AccountBasedExpenseLineDetail"),
        PrivateNote: privateNote(f.memo, key, env),
      };
    }
    case "Bill": {
      const f = req.fields;
      parseDate(f.txnDate);
      if (f.dueDate !== undefined) parseDate(f.dueDate);
      return {
        TxnDate: f.txnDate,
        VendorRef: ref(f.vendorId),
        ...(f.dueDate !== undefined && { DueDate: f.dueDate }),
        Line: lines(f.lines, "AccountBasedExpenseLineDetail"),
        PrivateNote: privateNote(f.memo, key, env),
      };
    }
    case "Deposit": {
      const f = req.fields;
      parseDate(f.txnDate);
      return {
        TxnDate: f.txnDate,
        DepositToAccountRef: ref(f.depositToAccountId),
        Line: lines(f.lines, "DepositLineDetail"),
        PrivateNote: privateNote(f.memo, key, env),
      };
    }
    case "Vendor": {
      const name = req.fields.displayName.trim();
      if (!name || [...name].some((c) => c < " " || c === "\x7f")) throw new Error("QBO Vendor DisplayName is empty or has a control character");
      return { DisplayName: name };
    }
  }
}

/** A balanced JournalEntry body: debits equal credits, every amount a positive whole number of cents. */
function journalBody(f: JournalEntryFields, key: string, env: QboEnv): Record<string, unknown> {
  parseDate(f.txnDate);
  const total = (side: JournalLine["postingType"]) => f.lines.filter((l) => l.postingType === side).reduce((sum, l) => sum + l.amountCents, 0);
  for (const l of f.lines) {
    if (l.postingType !== "Debit" && l.postingType !== "Credit") throw new Error(`QBO journal PostingType must be Debit or Credit, got "${String(l.postingType)}"`);
    if (!Number.isSafeInteger(l.amountCents) || l.amountCents <= 0) throw new Error("QBO journal line amounts must be positive whole cents");
  }
  if (total("Debit") === 0 || total("Debit") !== total("Credit")) throw new Error("QBO journal entry is not balanced");
  return {
    TxnDate: f.txnDate,
    Line: f.lines.map((l) => ({
      Amount: centsToDollars(l.amountCents),
      DetailType: "JournalEntryLineDetail",
      JournalEntryLineDetail: { PostingType: l.postingType, AccountRef: ref(l.accountId), ...(l.classId !== undefined && { ClassRef: ref(l.classId) }) },
      ...(l.description !== undefined && { Description: l.description }),
    })),
    PrivateNote: privateNote(f.memo, key, env),
  };
}

/** The entities the created-since read covers: the ones the app creates transactions in. */
interface CreatedEntity {
  Deposit: QboDeposit;
  Purchase: QboPurchase;
  Bill: QboBill;
  JournalEntry: QboJournalEntry;
}

export class QuickBooksClient {
  private readonly tokens: AccessTokenSource;
  private readonly realm: QboRealm;
  /** Which QBO API this client talks to; sandbox writes carry the test marker. */
  get env(): QboEnv {
    return this.realm.env;
  }

  /** intuit_tid of the most recent API response — quote it when contacting Intuit support. */
  lastTid: string | null = null;

  constructor(tokens: AccessTokenSource, realm: QboRealm) {
    assertRealmAllowed(realm);
    this.tokens = tokens;
    this.realm = realm;
  }

  /**
   * Run a QBO SQL-ish query. Callers build `sql` only from qboString/qboDate literals.
   * An expired token is an error for the caller to retry; the client never refreshes.
   */
  async query<T>(sql: string): Promise<T[]> {
    const url = `${apiBase(this.realm.env)}/v3/company/${this.realm.realmId}/query?query=${encodeURIComponent(sql)}&minorversion=${MINOR_VERSION}`;
    const body = (await this.send("query", url, {})) as { QueryResponse?: Record<string, T[]> };
    const resp = body.QueryResponse ?? {};
    const key = Object.keys(resp).find((k) => Array.isArray(resp[k]));
    return key ? resp[key] : [];
  }

  private async paged<T>(select: string): Promise<T[]> {
    const out: T[] = [];
    for (let start = 1; ; start += PAGE_SIZE) {
      const page = await this.query<T>(`${select} STARTPOSITION ${start} MAXRESULTS ${PAGE_SIZE}`);
      out.push(...page);
      if (page.length < PAGE_SIZE) break;
    }
    return out;
  }

  /** Every `entity` with TxnDate in [from, to], both inclusive YYYY-MM-DD, at most MAX_WINDOW_DAYS wide. */
  private async between<T>(entity: string, from: string, to: string): Promise<T[]> {
    const days = (parseDate(to).getTime() - parseDate(from).getTime()) / DAY_MS + 1;
    if (days < 1) throw new Error(`QBO window is reversed: ${from} > ${to}`);
    if (days > MAX_WINDOW_DAYS) throw new Error(`QBO window ${from}..${to} is ${days} days; the limit is ${MAX_WINDOW_DAYS}`);
    return this.paged<T>(`SELECT * FROM ${entity} WHERE TxnDate >= ${qboDate(from)} AND TxnDate <= ${qboDate(to)}`);
  }

  /** Purchases = cash/check/card expenses. */
  purchasesBetween(from: string, to: string): Promise<QboPurchase[]> {
    return this.between("Purchase", from, to);
  }

  /** Bills = vendor invoices (a separate QBO entity from Purchase). */
  billsBetween(from: string, to: string): Promise<QboBill[]> {
    return this.between("Bill", from, to);
  }

  billPaymentsBetween(from: string, to: string): Promise<QboBillPayment[]> {
    return this.between("BillPayment", from, to);
  }

  depositsBetween(from: string, to: string): Promise<QboDeposit[]> {
    return this.between("Deposit", from, to);
  }

  journalEntriesBetween(from: string, to: string): Promise<QboJournalEntry[]> {
    return this.between("JournalEntry", from, to);
  }

  /**
   * Every `entity` QuickBooks created since `since`, oldest first and once each. `since` comes from
   * the app's clock and CreateTime from QuickBooks', so the read starts CREATED_SINCE_MARGIN_MS
   * earlier, and callers get entries from before `since`. `full` means the read stopped at
   * CREATED_SINCE_MAX_PAGES and more entries may exist. Creation time is kept when finance edits
   * an entry's date, so this finds an entry a dated window misses.
   */
  async createdSince<E extends keyof CreatedEntity>(entity: E, since: Date): Promise<{ entries: CreatedEntity[E][]; full: boolean }> {
    if (Number.isNaN(since.getTime())) throw new Error("QBO createdSince needs a valid time");
    const at = `${new Date(since.getTime() - CREATED_SINCE_MARGIN_MS).toISOString().slice(0, 19)}Z`;
    const byId = new Map<string, CreatedEntity[E]>();
    for (let page = 0; page < CREATED_SINCE_MAX_PAGES; page++) {
      const rows = await this.query<CreatedEntity[E]>(
        `SELECT * FROM ${entity} WHERE MetaData.CreateTime >= '${at}' ORDERBY MetaData.CreateTime STARTPOSITION ${page * PAGE_SIZE + 1} MAXRESULTS ${PAGE_SIZE}`,
      );
      for (const row of rows) byId.set(row.Id, row);
      if (rows.length < PAGE_SIZE) return { entries: [...byId.values()], full: false };
    }
    return { entries: [...byId.values()], full: true };
  }

  /** The books closing date (YYYY-MM-DD), or null when finance has set none (absent, null or empty). Throws when the read fails. */
  async bookCloseDate(): Promise<string | null> {
    const [prefs] = await this.query<QboPreferences>("SELECT * FROM Preferences");
    if (!prefs) throw new Error(`QBO Preferences read returned nothing (intuit_tid=${this.lastTid})`);
    const date = prefs.AccountingInfoPrefs?.BookCloseDate;
    if (!date) return null;
    parseDate(date);
    return date;
  }

  /** Every `entity` with one of `ids`, at most one page of ids. */
  private async byIds<T>(entity: string, ids: readonly string[]): Promise<T[]> {
    if (ids.length === 0) return [];
    if (ids.length > PAGE_SIZE) throw new Error(`QBO id lookup takes at most ${PAGE_SIZE} ids, got ${ids.length}`);
    return this.query<T>(`SELECT * FROM ${entity} WHERE Id IN (${ids.map(qboString).join(", ")})`);
  }

  /** The BillPayments a Bill's LinkedTxn names. */
  billPaymentsByIds(ids: readonly string[]): Promise<QboBillPayment[]> {
    return this.byIds("BillPayment", ids);
  }

  /** Bills by id: a claimed reimbursement Bill's Balance and LinkedTxn. */
  billsByIds(ids: readonly string[]): Promise<QboBill[]> {
    return this.byIds("Bill", ids);
  }

  /** Purchases by id: a backfilled receipt's hand-booked transaction. */
  purchasesByIds(ids: readonly string[]): Promise<QboPurchase[]> {
    return this.byIds("Purchase", ids);
  }

  depositsByIds(ids: readonly string[]): Promise<QboDeposit[]> {
    return this.byIds("Deposit", ids);
  }

  journalEntriesByIds(ids: readonly string[]): Promise<QboJournalEntry[]> {
    return this.byIds("JournalEntry", ids);
  }

  /** Reference lists (active entries) for the FINANCE bootstrap; not transaction history. */
  accounts(): Promise<QboAccount[]> {
    return this.paged("SELECT * FROM Account");
  }

  classes(): Promise<QboClass[]> {
    return this.paged("SELECT * FROM Class");
  }

  vendors(): Promise<QboVendor[]> {
    return this.paged("SELECT * FROM Vendor");
  }

  /** Lookup for bootstrap UIs; mappings store the Id. FullyQualifiedName is "Parent:Child" and unique. */
  async accountNamed(fullyQualifiedName: string): Promise<QboAccount | null> {
    const [a] = await this.query<QboAccount>(`SELECT * FROM Account WHERE FullyQualifiedName = ${qboString(fullyQualifiedName)}`);
    return a ?? null;
  }

  async classNamed(fullyQualifiedName: string): Promise<QboClass | null> {
    const [c] = await this.query<QboClass>(`SELECT * FROM Class WHERE FullyQualifiedName = ${qboString(fullyQualifiedName)}`);
    return c ?? null;
  }

  /** DisplayName is unique across QBO names, so this returns at most one vendor. */
  async vendorNamed(name: string): Promise<QboVendor | null> {
    const [v] = await this.query<QboVendor>(`SELECT * FROM Vendor WHERE DisplayName = ${qboString(name)}`);
    return v ?? null;
  }

  /** Finance's Vendor picker: up to 20 active Vendors whose DisplayName contains `text`. */
  vendorsMatching(text: string): Promise<QboVendor[]> {
    return this.query<QboVendor>(`SELECT * FROM Vendor WHERE DisplayName LIKE ${qboString(`%${text.replace(/%/g, "")}%`)} MAXRESULTS 20`);
  }

  async vendorById(id: string): Promise<QboVendor | null> {
    const [v] = await this.byIds<QboVendor>("Vendor", [id]);
    return v ?? null;
  }

  /** DisplayName is unique across Customers, Vendors and Employees; a new Vendor must not reuse a Customer's. */
  async customerNamed(name: string): Promise<QboCustomer | null> {
    const [c] = await this.query<QboCustomer>(`SELECT * FROM Customer WHERE DisplayName = ${qboString(name)}`);
    return c ?? null;
  }

  /**
   * One QBO request with a timeout and one Retry-After retry on 429. An error names the
   * status, intuit_tid and QBO fault codes only; the fault text can echo names and memos.
   */
  private async send(what: string, url: string, init: { method?: "POST"; body?: string }): Promise<unknown> {
    const token = await this.tokens.current();
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      // intuit_tid is Intuit's per-request trace id — capture it for support/debugging every call.
      this.lastTid = res.headers.get("intuit_tid");
      if (res.status === 429 && attempt === 1) {
        const wait = Number(res.headers.get("Retry-After") ?? "1");
        await new Promise((r) => setTimeout(r, Math.min(Number.isFinite(wait) ? wait : 1, MAX_RETRY_AFTER_S) * 1000));
        continue;
      }
      if (!res.ok) throw new QboRequestError(`QBO ${what} failed ${res.status} (intuit_tid=${this.lastTid})`, await faultCodes(res));
      return res.json();
    }
  }

  /**
   * The app's only QuickBooks write: create one entity of WRITABLE_ENTITIES. There is no
   * update, delete or void. `key` is sent as `requestid`, so QBO answers a quick retry with
   * the first result; the package's callers look the key up first for a retry days later.
   */
  async [CREATE](request: WriteRequest, key: string): Promise<{ Id: string }> {
    if (!(WRITABLE_ENTITIES as readonly string[]).includes(request.entity)) {
      throw new Error(`QBO entity "${String(request.entity)}" is not writable`);
    }
    assertAppKey(key);
    assertRealmAllowed(this.realm);
    return this.post(request.entity, writeBody(request, key, this.realm.env), key);
  }

  /** The one create request: the body is marked for the realm's environment and checked just before it is sent. */
  private async post(entity: WritableEntity | "JournalEntry", body: Record<string, unknown>, key: string): Promise<{ Id: string }> {
    assertPayloadMarked(this.realm.env, entity, body);
    const url = `${apiBase(this.realm.env)}/v3/company/${this.realm.realmId}/${entity.toLowerCase()}?minorversion=${MINOR_VERSION}&requestid=${encodeURIComponent(key)}`;
    const res = await this.send(`create ${entity}`, url, { method: "POST", body: JSON.stringify(body) });
    const created = (res as Record<string, { Id?: string } | undefined>)[entity];
    if (!created?.Id) throw new Error(`QBO create ${entity} returned no Id (intuit_tid=${this.lastTid})`);
    return { Id: created.Id };
  }

  /** Creates one balanced JournalEntry; only findOrCreateInKindJournal calls it, after checking every account is an in-kind role's. */
  async [CREATE_JOURNAL](fields: JournalEntryFields, key: string): Promise<{ Id: string }> {
    assertAppKey(key);
    assertRealmAllowed(this.realm);
    return this.post("JournalEntry", journalBody(fields, key, this.realm.env), key);
  }
}

export function toGroundTruth(p: QboPurchase, entity: "Purchase" | "Bill" = "Purchase"): GroundTruthRecord {
  const vendorRef = p.EntityRef ?? p.VendorRef;
  return {
    qbId: p.Id,
    entity,
    vendor: vendorRef?.name ?? "",
    date: p.TxnDate,
    total: p.TotalAmt,
    tax: p.TxnTaxDetail?.TotalTax ?? 0,
    currency: p.CurrencyRef?.value ?? "USD",
    docNumber: p.DocNumber,
    memo: p.PrivateNote || undefined,
    lines: (p.Line ?? []).map((l) => ({ description: l.Description, amount: l.Amount ?? 0 })),
  };
}
