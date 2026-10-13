// Ports the host (checkin-app) binds via configureBulkDonation(). The library never imports the
// host or another library; every crossing is one of these, bound once at boot.
import { z } from "zod";
import type { ResolvedInventoryDelta } from "@inventory/receipt-types";

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

/** The two matching streams, each with its own takeover line. */
export type QbStream = "benevity" | "in_kind";

/** One create-or-find request to the shared QuickBooks find-or-create (L4). */
export interface DonationQbPostRequest {
  stream: QbStream;
  /** Org + disbursement id, or the in-kind donation id. A retry never books twice. */
  retryKey: string;
  netCents: number;
  /** YYYY-MM-DD; candidates are searched within 7 days of it. */
  depositDate: string;
  /** The stream's derived takeover line; null means create nothing. */
  takeoverLine: string | null;
  claimedQbTxnIds: string[];
  excludedQbTxnIds: string[];
}

export type DonationQbPostResult =
  | { kind: "found"; qbTxnId: string }
  | { kind: "created"; qbTxnId: string }
  | { kind: "ambiguous"; candidateQbTxnIds: string[] }
  | { kind: "before_line" }
  | { kind: "failed"; reason: string };

/** The QuickBooks writer (L4's closed-enum, create-only writer behind the find-or-create). */
export interface DonationQbWriter {
  post(request: DonationQbPostRequest): Promise<DonationQbPostResult>;
}

export interface BulkDonationConfig {
  auth: BulkDonationAuth;
  org: () => OrgIdentity;
  owners?: OwnerDirectory;
  catalog?: CatalogLookup;
  inventory?: InventoryApply;
  qb?: DonationQbWriter;
}
