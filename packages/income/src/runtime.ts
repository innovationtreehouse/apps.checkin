import type { QuickBooksClient } from "@checkin/quickbooks";
import type {
  IncomeAuth,
  IncomePrincipal,
  OrgIdentity,
  OtherLaneClaims,
  OwnerDirectory,
  PayoutMirror,
  QbDepositSource,
} from "./contract";
import type { DepositAccount } from "./lib/deposit-lines";

/** QuickBooks account ids a created deposit's lines book to. */
export type IncomeQbAccounts = Record<DepositAccount, string>;

/** What the create path needs to write deposits. Unbound, payouts after the line wait. */
export interface IncomePosting {
  client: QuickBooksClient;
  accounts: IncomeQbAccounts;
  /**
   * True only on a deploy whose Shopify mirror keeps the newest version of every row, so a
   * replay cannot hand the create path a reverted payout. Anything else creates nothing.
   */
  mirrorNewestWins: boolean;
}

/** One outbox drain stopped at a cap with payouts still due, or parked a payout over it. */
export interface PostCapEvent {
  orgId: string;
  cap: "count" | "cents";
  created: number;
  createdCents: number;
  remaining: number;
}

/** Finance alerts the host binds. The drain creates nothing while they are unbound. */
export interface IncomeAlerts {
  postCapReached(event: PostCapEvent): Promise<void>;
}

export interface IncomeConfig {
  /** Who is acting; the routes need it, the reconcile engine does not. */
  auth?: IncomeAuth;
  /** Org identity as an async accessor, called per request: the host may read it from its store. */
  org?: () => Promise<OrgIdentity>;
  mirror?: PayoutMirror;
  deposits?: QbDepositSource;
  owners?: OwnerDirectory;
  /** QuickBooks id of the bank account payouts land in. Unset, nothing is matched. */
  bankAccountId?: string;
  posting?: IncomePosting;
  alerts?: IncomeAlerts;
  otherLaneClaims?: OtherLaneClaims;
  /** Days after a payout within which its deposit must be booked. */
  windowDays?: number;
  /** Days before a payout a deposit may still be dated, for QuickBooks dates that run early. */
  dateGraceDays?: number;
  /** Earliest payout date to reconcile. Defaults to the oldest payout in the mirror. */
  reconcileFrom?: Date;
}

// On globalThis so the instrumentation chunk that configures it and the route chunks that
// read it share one runtime (and it survives dev HMR).
const globalForRuntime = globalThis as typeof globalThis & { __incomeRuntime?: IncomeConfig };

export function configureIncome(next: IncomeConfig): void {
  globalForRuntime.__incomeRuntime = { ...next };
}

export function getIncomeConfig(): IncomeConfig {
  return globalForRuntime.__incomeRuntime ?? {};
}

/** The acting host user. Throws if absent: host admission has already run. */
export async function getPrincipal(): Promise<IncomePrincipal> {
  const auth = getIncomeConfig().auth;
  if (!auth) throw new Error("income runtime not configured: the host must pass auth to configureIncome()");
  const principal = await auth.getPrincipal();
  if (!principal || !Number.isInteger(principal.id)) {
    throw new Error("no income principal: host admission should have rejected this request");
  }
  return principal;
}

/** The current request's org id, the scope of every income row. */
export async function getOrgId(): Promise<string> {
  const org = getIncomeConfig().org;
  if (!org) throw new Error("income runtime not configured: the host must pass org to configureIncome()");
  return (await org()).id;
}

/** YYYY-MM-DD in UTC, the format CSV payout dates and QB txnDates use. */
export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
