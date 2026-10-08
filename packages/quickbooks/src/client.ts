import type {
  AccessTokenSource,
  QboAccount,
  QboBill,
  QboBillPayment,
  QboClass,
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
    const token = await this.tokens.current();
    const url = `${apiBase(this.realm.env)}/v3/company/${this.realm.realmId}/query?query=${encodeURIComponent(sql)}&minorversion=${MINOR_VERSION}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    // intuit_tid is Intuit's per-request trace id — capture it for support/debugging every call.
    this.lastTid = res.headers.get("intuit_tid");
    if (!res.ok) throw new Error(`QBO query failed ${res.status} (intuit_tid=${this.lastTid}): ${await res.text()}`);
    const body = (await res.json()) as { QueryResponse?: Record<string, T[]> };
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
