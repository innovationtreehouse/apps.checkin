// Ports the host (checkin-app) binds via configureBulkDonation(). The library never imports the
// host or another library; every crossing is one of these, bound once at boot.
import { z } from "zod";
import type { QuickBooksClient } from "@checkin/quickbooks";
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
  /** Everyone in the given people's households, the people themselves included. */
  householdOf(personIds: number[]): Promise<number[]>;
  /** Whether anyone in this person's household, the person included, shares the given surname. */
  householdSharesSurname(personId: number, lastName: string): Promise<boolean>;
  /** The buckets whose approvers (program leader and treasurers) include this person. */
  bucketsApprovedBy(personId: number): Promise<number[]>;
  /** The expense library's large-spend amount; a gift valued at or over it warns its decider. */
  largeValueCents(): Promise<number>;
}

export interface BulkDonationConfig {
  auth: BulkDonationAuth;
  /** Called once per request: the host may resolve it from its own store, so never at boot. */
  org: () => Promise<OrgIdentity>;
  owners?: OwnerDirectory;
  catalog?: CatalogLookup;
  inventory?: InventoryApply;
  qb?: DonationQbPosting;
  otherLaneClaims?: OtherLaneClaims;
  inKind?: InKindDirectory;
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
