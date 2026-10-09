import { createHash } from "node:crypto";
import { centsToDollars } from "@inventory/money";
import { CREATE } from "./internal";
import type {
  AccessTokenSource,
  QboAccount,
  QboBill,
  QboBillPayment,
  QboClass,
  QboCustomer,
  QboDeposit,
  QboEnv,
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
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRY_AFTER_S = 10;

/** `: codes 6240,610` from a QBO Fault body, or nothing; never the fault's free text. */
async function faultCodes(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { Fault?: { Error?: { code?: unknown }[] } };
    const codes = (body.Fault?.Error ?? []).map((e) => e.code).filter((c): c is string => typeof c === "string" && /^\d+$/.test(c));
    return codes.length ? `: codes ${codes.join(",")}` : "";
  } catch {
    return "";
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
 * The only entities the app may create. A reimbursement is a Bill the app never pays;
 * BillPayment, Payment, JournalEntry and every other entity are refused.
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

/** The app key a created transaction carries in its PrivateNote; undefined on hand-booked entries. */
export function appKeyOf(entry: { PrivateNote?: string }): string | undefined {
  return KEY_MARKER.exec(entry.PrivateNote ?? "")?.[1];
}

function privateNote(memo: string | undefined, key: string): string {
  if (memo !== undefined && KEY_MARKER.test(memo)) throw new Error("QBO memo must not carry an app key marker");
  const note = memo ? `${memo}\n[checkin:${key}]` : `[checkin:${key}]`;
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
function writeBody(req: WriteRequest, key: string): Record<string, unknown> {
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
        PrivateNote: privateNote(f.memo, key),
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
        PrivateNote: privateNote(f.memo, key),
      };
    }
    case "Deposit": {
      const f = req.fields;
      parseDate(f.txnDate);
      return {
        TxnDate: f.txnDate,
        DepositToAccountRef: ref(f.depositToAccountId),
        Line: lines(f.lines, "DepositLineDetail"),
        PrivateNote: privateNote(f.memo, key),
      };
    }
    case "Vendor": {
      const name = req.fields.displayName.trim();
      if (!name || [...name].some((c) => c < " " || c === "\x7f")) throw new Error("QBO Vendor DisplayName is empty or has a control character");
      return { DisplayName: name };
    }
  }
}

export class QuickBooksClient {
  private readonly tokens: AccessTokenSource;
  private readonly realm: QboRealm;
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

  /** The BillPayments a Bill's LinkedTxn names, at most one page of ids. */
  async billPaymentsByIds(ids: readonly string[]): Promise<QboBillPayment[]> {
    if (ids.length === 0) return [];
    if (ids.length > PAGE_SIZE) throw new Error(`QBO id lookup takes at most ${PAGE_SIZE} ids, got ${ids.length}`);
    return this.query<QboBillPayment>(`SELECT * FROM BillPayment WHERE Id IN (${ids.map(qboString).join(", ")})`);
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
      if (!res.ok) throw new Error(`QBO ${what} failed ${res.status} (intuit_tid=${this.lastTid})${await faultCodes(res)}`);
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
    const body = writeBody(request, key);
    const url = `${apiBase(this.realm.env)}/v3/company/${this.realm.realmId}/${request.entity.toLowerCase()}?minorversion=${MINOR_VERSION}&requestid=${encodeURIComponent(key)}`;
    const res = await this.send(`create ${request.entity}`, url, { method: "POST", body: JSON.stringify(body) });
    const created = (res as Record<string, { Id?: string } | undefined>)[request.entity];
    if (!created?.Id) throw new Error(`QBO create ${request.entity} returned no Id (intuit_tid=${this.lastTid})`);
    return { Id: created.Id };
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
