// Ports the host (checkin-app) binds via configureBulkDonation(). The library never imports the
// host or another library; every crossing is one of these, bound once at boot.
import { z } from "zod";
import type { OnFailure } from "@checkin/component-kit";
import type { BooksMap, BooksMapRole, QboAccountList, QuickBooksClient } from "@checkin/quickbooks";
import type { DonatedCapitalLine, ResolvedInventoryDelta } from "@checkin/receipt-types";

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
export { InKindDonorSchema, type InKindDonor } from "@checkin/receipt-types";

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
  /** Why the last load under this source key failed; null once it loads, or if it never failed. */
  failureReason(sourceKey: string): Promise<string | null>;
}

/** Per-source idempotency key for X11, beside the receipt pipeline's `receipt:<id>`. */
export function inventorySourceKey(inKindDonationId: number): string {
  return `donation:${inKindDonationId}`;
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

/** One deposit line: a gift or match line on its rule's QuickBooks account, net of its fees, and the gift's bucket (null at organization level). */
export type DonationDepositLine = {
  accountId: string;
  budgetOwnerId: number | null;
  amountCents: number;
  description?: string;
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

/** A completed disbursement the daily job could not hand to income, and why in plain words. */
export type DepositHandOverFailure = { disbursementId: string; reason: string };

/** What income made of a disbursement's deposit. */
export type DonationDepositStatus =
  | { state: "waiting" }
  | { state: "booked" | "matched"; depositId: string; txnDate: string | null; totalCents: number | null }
  | { state: "with_finance"; kind: string | null; note: string | null }
  | { state: "drifted"; note: string | null }
  | { state: "dismissed"; reason: string | null };

/**
 * Income, which books and matches every deposit. Donation hands each completed disbursement over
 * after its own commit, re-sends any income does not know, and reads back what became of it.
 * Outside prod only a disbursement whose id starts with "TEST-" is handed over; prod never hands one over.
 */
export interface IncomeDeposits {
  expectDeposit(orgId: string, disbursementId: string, expected: DonationExpectedDeposit): Promise<unknown>;
  /** Per disbursement id; an id income has no row for is absent. */
  depositStatus(orgId: string, disbursementIds: string[]): Promise<Record<string, DonationDepositStatus>>;
  /** Tells finance about completed disbursements the daily job could not hand over. */
  handOverFailing(failures: DepositHandOverFailure[]): Promise<void>;
  prod: boolean;
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

export { DonatedCapitalLineSchema as CapitalReviewLineSchema, type DonatedCapitalLine as CapitalReviewLine } from "@checkin/receipt-types";

/** Donations → the expense library's capital review, for donated equipment. */
export interface InKindCapital {
  /** Sends an accepted gift's lines; the callee keeps those at or over its capital thresholds. A resend does nothing. */
  submit(orgId: string, lines: DonatedCapitalLine[]): Promise<void>;
  /** The gifts with a line still waiting on capital review. */
  awaitingReview(orgId: string): Promise<{ giftSource: string; giftId: number }[]>;
  /** The gift's lines capital review made assets; each books to a fixed-asset account. */
  assetLineIds(orgId: string, gift: { giftSource: "receipt" | "manual"; giftId: number }): Promise<number[]>;
}

/** One donated part to resolve: the gift line, its GTIN-13, and whether capital review made it an asset. */
export interface DonatedPart {
  lineId: number;
  gtin13: string;
  isCapital: boolean;
}

/** Donations → the expense library's account rules: each part's account, or why none resolves. */
export interface InKindAccounts {
  resolve(orgId: string, parts: DonatedPart[]): Promise<({ lineId: number } & ({ accountId: string } | { reason: string }))[]>;
}

export interface BulkDonationConfig {
  auth: BulkDonationAuth;
  /** Called once per request: the host may resolve it from its own store, so never at boot. */
  org: () => Promise<OrgIdentity>;
  onFailure?: OnFailure;
  owners?: OwnerDirectory;
  catalog?: CatalogLookup;
  inventory?: InventoryApply;
  inKindQb?: InKindQbPosting;
  deposits?: IncomeDeposits;
  inKind?: InKindDirectory;
  capital?: InKindCapital;
  /** QuickBooks' live account list, read when an account rule saves an account. */
  quickBooksAccounts?: QboAccountList;
  /** Each gift line's account from the expense account rules. */
  partAccounts?: InKindAccounts;
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
