// Ports the host (checkin-app) binds via configureBulkDonation(). The library never imports the
// host or another library; every crossing is one of these, bound once at boot.
import { z } from "zod";
import type { BooksMap, BooksMapRole, QuickBooksClient } from "@checkin/quickbooks";
import type { ResolvedInventoryDelta } from "@checkin/receipt-types";

/** The acting host user, projected to what rows stamp (actor ids and usernames). */
export interface BulkDonationPrincipal {
  id: number;
  name: string | null;
}

export interface BulkDonationAuth {
  /** The current host user, or null when unauthenticated. */
  getPrincipal(): Promise<BulkDonationPrincipal | null>;
}

/** The org this process serves; an accessor so multi-org can resolve it per request. */
export interface OrgIdentity {
  id: string;
  name: string;
}

/** A budget-owner bucket (checkin's BudgetOwner). Same shape income declares. */
export interface OwnerInfo {
  id: number;
  name: string;
  archivedAt: Date | null;
  /** The bucket's QuickBooks Class; a booked gift line carries it. */
  quickBooksClassId?: string | null;
}

/** Read-only list of checkin's budget-owner buckets. */
export interface OwnerDirectory {
  list(): Promise<OwnerInfo[]>;
}

/** The in-kind donor entered at receipt upload (X13). Never null: upload requires a donor. */
export const InKindDonorSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  companyName: z.string().nullable(),
});
export type InKindDonor = z.infer<typeof InKindDonorSchema>;

/** A catalog item as the no-receipt in-kind picker shows it (X10). */
export const CatalogItemSummarySchema = z.object({
  gtin13: z.string(),
  name: z.string(),
});
export type CatalogItemSummary = z.infer<typeof CatalogItemSummarySchema>;

/** X10: donations → catalog, item search and lookup for the no-receipt picker. */
export interface CatalogLookup {
  search(query: string): Promise<CatalogItemSummary[]>;
  getItem(gtin13: string): Promise<CatalogItemSummary | null>;
}

/**
 * X11: donations → local-inventory apply. `delta.receiptId` carries the per-source key
 * `donation:<id>` (see inventorySourceKey), which the callee's apply guard is idempotent on.
 */
export interface InventoryApply {
  apply(delta: ResolvedInventoryDelta): Promise<void>;
}

/** Per-source idempotency key for X11, beside the receipt pipeline's `receipt:<id>`. */
export function inventorySourceKey(inKindDonationId: number): string {
  return `donation:${inKindDonationId}`;
}

/**
 * What the QuickBooks drain books with: checkin's one guarded client (null while the guard keeps
 * QuickBooks off), the bank account Benevity disbursements land in, and whether this is prod.
 * Outside prod only a disbursement whose id starts with "TEST-" is sent; prod never sends one.
 */
export interface DonationQbPosting {
  client(): Promise<QuickBooksClient | null>;
  bankAccountId: string;
  prod: boolean;
  /** Tells finance the daily orphan sweep read a full page, so some Deposits went unchecked. */
  sweepIncomplete(event: { orgId: string; since: Date }): Promise<void>;
}

/**
 * What the in-kind drain books with: checkin's one guarded client (null while the guard keeps
 * QuickBooks off) and the books map, which names every account an in-kind journal entry uses.
 */
export interface InKindQbPosting {
  client(): Promise<QuickBooksClient | null>;
  booksMap: BooksMap;
  /** Tells finance the daily orphan sweep read a full page, so some JournalEntries went unchecked. */
  sweepIncomplete(event: { orgId: string; since: Date }): Promise<void>;
}

/** One line of a disbursement's deposit: kind's account role, the gift's bucket (null at organization level), signed cents. */
export type DonationDepositLine = {
  role: BooksMapRole;
  budgetOwnerId: number | null;
  amountCents: number;
  description?: string;
  /** The account map's QuickBooks account name, used while the books map leaves `role` unset. */
  accountName?: string;
};

/** The deposit a completed disbursement should land as; income books or matches it. */
export type DonationExpectedDeposit = {
  /** YYYY-MM-DD. */
  txnDate: string;
  netCents: number;
  bankRole: BooksMapRole;
  lines: DonationDepositLine[];
  memo?: string;
};

/** What income made of a disbursement's deposit. */
export type DonationDepositStatus =
  | { state: "waiting" }
  | { state: "booked" | "matched"; depositId: string; txnDate: string | null; totalCents: number | null }
  | { state: "with_finance"; kind: string | null; note: string | null }
  | { state: "drifted"; note: string | null }
  | { state: "dismissed"; reason: string | null };

/** Where donation left a disbursement's QuickBooks deposit, as the move hands it to income. */
export type DonationHeldState = "waiting" | "matched" | "created" | "ambiguous" | "unbooked" | "needs_finance" | "drifted" | "dismissed";

export type DonationHolding = {
  sourceKey: string;
  createdAt: Date;
  txnDate: string;
  netCents: number;
  expected: DonationExpectedDeposit | null;
  state: DonationHeldState;
  depositId: string | null;
  depositTxnDate: string | null;
  depositTotalCents: number | null;
  driftCause: string | null;
  createAttemptedAt: Date | null;
  note: string | null;
  dismissal: { reason: string; byUserId: number | null; at: Date } | null;
};

export type DonationHoldingsMove = {
  holdings: DonationHolding[];
  exclusions: { qbTxnId: string; reason: string; excludedByUserId: number; excludedAt: Date }[];
  postingOnAt: Date | null;
};

/**
 * Income, which books and matches every deposit. Donation hands each completed disbursement over
 * after its own commit, re-sends any income does not know, and reads back what became of it.
 * Outside prod only a disbursement whose id starts with "TEST-" is handed over; prod never hands one over.
 */
export interface IncomeDeposits {
  expectDeposit(orgId: string, disbursementId: string, expected: DonationExpectedDeposit): Promise<unknown>;
  /** Per disbursement id; an id income has no row for is absent. */
  depositStatus(orgId: string, disbursementIds: string[]): Promise<Record<string, DonationDepositStatus>>;
  /** The one-off move of donation's holdings; throws, writing nothing, when it must stop. */
  adoptHoldings(orgId: string, move: DonationHoldingsMove): Promise<unknown>;
  prod: boolean;
  /** Tells finance the move stopped and why; called once per cause. */
  moveStopped(event: { orgId: string; cause: string }): Promise<void>;
}

/** QuickBooks Deposits another lane (income) holds, kept out of this lane's matching. */
export interface OtherLaneClaims {
  claimedDepositIds(orgId: string): Promise<string[]>;
}

/**
 * Who may decide an in-kind gift, read from checkin's roles, programs and households. Person ids
 * are checkin Person.id.
 */
export interface InKindDirectory {
  financeHolders(): Promise<number[]>;
  boardMembers(): Promise<number[]>;
  /** Each person's household member ids, the person included, read in one batch. */
  householdsOf(personIds: number[]): Promise<Map<number, number[]>>;
  /** For each check, whether anyone in the person's household, the person included, has that surname; one batch. */
  householdsSharingSurname(checks: { personId: number; lastName: string }[]): Promise<boolean[]>;
  /** The buckets whose approvers (owner and treasurers) include this person. */
  bucketsApprovedBy(personId: number): Promise<number[]>;
  /** The expense library's large-spend amount; a gift valued at or over it warns its decider. */
  largeValueCents(): Promise<number>;
}

/** An accepted gift line as capital review takes it; its cost includes its share of tax and shipping. */
export interface CapitalReviewLine {
  giftSource: "receipt" | "manual";
  giftId: number;
  giftLineId: number;
  description: string;
  quantity: number;
  costCents: number;
  acquisitionDate: string | null;
  budgetOwnerId: number;
}

/** Donations → the expense library's capital review, for donated equipment. */
export interface InKindCapital {
  /** Sends an accepted gift's lines; the callee keeps those at or over its capital thresholds. A resend does nothing. */
  submit(orgId: string, lines: CapitalReviewLine[]): Promise<void>;
  /** The gifts with a line still waiting on capital review. */
  awaitingReview(orgId: string): Promise<{ giftSource: string; giftId: number }[]>;
  /** The gift's lines capital review made assets; they book to fixed assets. */
  assetLineIds(orgId: string, gift: { giftSource: "receipt" | "manual"; giftId: number }): Promise<number[]>;
}

export interface BulkDonationConfig {
  auth: BulkDonationAuth;
  /** Called once per request: the host may resolve it from its own store, so never at boot. */
  org: () => Promise<OrgIdentity>;
  owners?: OwnerDirectory;
  catalog?: CatalogLookup;
  inventory?: InventoryApply;
  qb?: DonationQbPosting;
  inKindQb?: InKindQbPosting;
  deposits?: IncomeDeposits;
  otherLaneClaims?: OtherLaneClaims;
  inKind?: InKindDirectory;
  capital?: InKindCapital;
}

/** The slice of a route context a factory consumes: request + path params. */
export interface DonationRouteCtx {
  req: Request;
  params: Record<string, string>;
}

/** A route factory's body: parse → service → model bag (stripped by the host). */
export type DonationBag = Record<string, unknown>;
export type DonationRouteHandler = (ctx: DonationRouteCtx) => Promise<DonationBag>;

/** A stored file a file-route factory serves; the host emits `row.fileBlob`. */
export interface DonationFile {
  row: Record<string, unknown>;
  contentType: "text/plain";
  filename?: string;
}
export type DonationFileRouteHandler = (ctx: DonationRouteCtx) => Promise<DonationFile>;
