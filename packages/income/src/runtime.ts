import type { QuickBooksClient } from "@inventory/quickbooks";
import type { OwnerDirectory, PayoutMirror, QbDepositSource } from "./contract";
import type { DepositAccount } from "./lib/deposit-lines";

/** QuickBooks account ids a created deposit books to: the bank it lands in, and one per line account. */
export type IncomeQbAccounts = { bank: string } & Record<DepositAccount, string>;

/** What the create path needs to write deposits. Unbound, payouts after the line wait. */
export interface IncomePosting {
  client: QuickBooksClient;
  accounts: IncomeQbAccounts;
}

export interface IncomeConfig {
  mirror?: PayoutMirror;
  deposits?: QbDepositSource;
  owners?: OwnerDirectory;
  posting?: IncomePosting;
  /** Days after a payout within which its deposit must be booked. */
  windowDays?: number;
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
