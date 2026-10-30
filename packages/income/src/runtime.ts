import { defineRuntime } from "@checkin/component-kit";
import type { BooksMap, QuickBooksClient } from "@checkin/quickbooks";
import type {
  IncomeAuth,
  IncomePrincipal,
  OrgIdentity,
  OwnerDirectory,
  PayoutMirror,
  QbClassSource,
  QbDepositSource,
} from "./contract";

/** What the create path needs to write deposits. Unbound, nothing is created. */
export interface IncomePosting {
  client: QuickBooksClient;
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

/** A bucket items are assigned to became unusable: archived, Class-less, or its Class inactive. */
export interface BucketUnusableEvent {
  orgId: string;
  budgetOwnerId: number;
  bucketName: string | null;
  issue: string;
  itemCount: number;
}

/** Finance alerts the host binds. The drain creates nothing while they are unbound. */
export interface IncomeAlerts {
  postCapReached(event: PostCapEvent): Promise<void>;
  /** Fires once per bucket each time it becomes unusable, not once per sale. */
  bucketUnusable(event: BucketUnusableEvent): Promise<void>;
  /** The orphan sweep read a full page, so some deposits the app created may have gone unchecked. */
  sweepIncomplete(event: { orgId: string; since: Date }): Promise<void>;
}

export interface IncomeConfig {
  /** Who is acting; the routes need it, the reconcile engine does not. */
  auth?: IncomeAuth;
  /** Org identity as an async accessor, called per request: the host may read it from its store. */
  org?: () => Promise<OrgIdentity>;
  mirror?: PayoutMirror;
  deposits?: QbDepositSource;
  owners?: OwnerDirectory;
  /**
   * Active QuickBooks Classes. Unbound or unreachable, no item can be assigned to a bucket, and
   * a payout with a sale of a bucketed item holds as NEEDS_MAPPING; general-income payouts still post.
   */
  classes?: QbClassSource;
  /** Finance's books map: role -> QuickBooks account, bucket -> Class. A source whose bank role it leaves unset is not matched. */
  booksMap?: BooksMap;
  posting?: IncomePosting;
  alerts?: IncomeAlerts;
  /** Days after a payout within which its deposit must be booked. */
  windowDays?: number;
  /** Days before a payout a deposit may still be dated, for QuickBooks dates that run early. */
  dateGraceDays?: number;
  /** Earliest payout date to reconcile. Defaults to the oldest payout in the mirror. */
  reconcileFrom?: Date;
}

export const incomeRuntime = defineRuntime<IncomeConfig, IncomePrincipal>("income");

export function configureIncome(next: IncomeConfig): void {
  incomeRuntime.configure({ ...next });
}

export const getIncomeConfig = incomeRuntime.require;

/** The acting host user. A 401 if absent: host admission has already run. */
export const getPrincipal = incomeRuntime.getPrincipal;

/** The current request's org id, the scope of every income row. */
export const getOrgId = incomeRuntime.getOrgId;

/** Callee guard: a crossing payload must carry the injected org. */
export const assertOrg = incomeRuntime.assertOrg;

/** YYYY-MM-DD in UTC, the format CSV payout dates and QB txnDates use. */
export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
