import { oauthConfigFromEnv, refreshTokens, isExpired, loadTokens, saveTokens } from "./oauth";
import type { QboEnv, QboPurchase, QboTokens, GroundTruthRecord } from "./types";

const MINOR_VERSION = "70";

function apiBase(env: QboEnv): string {
  return env === "production"
    ? "https://quickbooks.api.intuit.com"
    : "https://sandbox-quickbooks.api.intuit.com";
}

function envFromEnv(): QboEnv {
  return process.env.QBO_ENVIRONMENT === "production" ? "production" : "sandbox";
}

export class QuickBooksClient {
  private tokens: QboTokens;
  private env: QboEnv;
  /** intuit_tid of the most recent API response — quote it when contacting Intuit support. */
  lastTid: string | null = null;

  constructor(tokens: QboTokens, env: QboEnv = envFromEnv()) {
    this.tokens = tokens;
    this.env = env;
  }

  /** Build from the saved token file + env vars. Throws if consent hasn't been run. */
  static fromSaved(env: QboEnv = envFromEnv()): QuickBooksClient {
    const tokens = loadTokens();
    if (!tokens) throw new Error("No saved QBO tokens — run `npm run consent -w @inventory/quickbooks` first");
    return new QuickBooksClient(tokens, env);
  }

  private async ensureFresh(): Promise<void> {
    if (!isExpired(this.tokens)) return;
    this.tokens = await refreshTokens(oauthConfigFromEnv(), this.tokens);
    saveTokens(this.tokens); // refresh token rotates — persist or the next run is locked out
  }

  /** Run a QBO SQL-ish query, e.g. "SELECT * FROM Purchase WHERE TxnDate >= '2025-01-01'". */
  async query<T>(sql: string): Promise<T[]> {
    await this.ensureFresh();
    const url = `${apiBase(this.env)}/v3/company/${this.tokens.realmId}/query?query=${encodeURIComponent(sql)}&minorversion=${MINOR_VERSION}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.tokens.accessToken}`, Accept: "application/json" },
    });
    // intuit_tid is Intuit's per-request trace id — capture it for support/debugging every call.
    this.lastTid = res.headers.get("intuit_tid");
    if (!res.ok) throw new Error(`QBO query failed ${res.status} (intuit_tid=${this.lastTid}): ${await res.text()}`);
    const body = (await res.json()) as { QueryResponse?: Record<string, T[]> };
    const resp = body.QueryResponse ?? {};
    const key = Object.keys(resp).find((k) => Array.isArray(resp[k]));
    return key ? resp[key] : [];
  }

  /** Paged pull of one entity since a date. QBO caps STARTPOSITION paging at 1000/page. */
  private async pagedSince<T>(entity: string, fromDate: string): Promise<T[]> {
    const out: T[] = [];
    for (let start = 1; ; start += 1000) {
      const page = await this.query<T>(
        `SELECT * FROM ${entity} WHERE TxnDate >= '${fromDate}' STARTPOSITION ${start} MAXRESULTS 1000`
      );
      out.push(...page);
      if (page.length < 1000) break;
    }
    return out;
  }

  /** Purchases = cash/check/card expenses. */
  purchasesSince(fromDate: string): Promise<QboPurchase[]> {
    return this.pagedSince<QboPurchase>("Purchase", fromDate);
  }

  /** Bills = vendor invoices (a separate QBO entity from Purchase). */
  billsSince(fromDate: string): Promise<QboPurchase[]> {
    return this.pagedSince<QboPurchase>("Bill", fromDate);
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
