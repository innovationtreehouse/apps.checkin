import type { QuickBooksClient } from "@inventory/quickbooks";
import type { OwnerDirectory, PayoutMirror, QbDepositSource } from "./contract";
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

/** Finance alerts the host binds. Unbound, a hit cap is still reported in the drain counts. */
export interface IncomeAlerts {
  postCapReached(event: PostCapEvent): Promise<void>;
}

export interface IncomeConfig {
  mirror?: PayoutMirror;
  deposits?: QbDepositSource;
  owners?: OwnerDirectory;
  /** QuickBooks id of the bank account payouts land in. Unset, nothing is matched. */
  bankAccountId?: string;
  posting?: IncomePosting;
  alerts?: IncomeAlerts;
  /** Days after a payout within which its deposit must be booked. */
  windowDays?: number;
  /** Days before a payout a deposit may still be dated, for QuickBooks dates that run early. */
  dateGraceDays?: number;
  /** Earliest payout date to reconcile. Defaults to the oldest payout in the mirror. */
  reconcileFrom?: Date;
}

// ponytail: one runtime per process, set once at app boot.
let config: IncomeConfig = {};

export function configureIncome(next: IncomeConfig): void {
  config = { ...next };
}

export function getIncomeConfig(): IncomeConfig {
  return config;
}

/** YYYY-MM-DD in UTC, the format CSV payout dates and QB txnDates use. */
export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
