import type { PayoutMirror, QbDepositSource } from "./contract";

export interface IncomeConfig {
  mirror?: PayoutMirror;
  deposits?: QbDepositSource;
  /** First day the mirror covers. CSV payouts on or after it are rejected at import. */
  mirrorFrom?: Date;
  /** Days after a payout within which its deposit must be booked. */
  windowDays?: number;
  /** Earliest payout date to reconcile. Defaults to every CSV payout. */
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
