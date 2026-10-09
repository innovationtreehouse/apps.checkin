// Ports the host (checkin-app) binds via configureExpense(). Every port has an inert adapter
// here; an unbound port behaves as that adapter, so nothing reaches another library, checkin
// or QuickBooks until the host binds it.
import { z } from "zod";
import {
  CatalogCategorySchema,
  CatalogSubcategorySchema,
  ItemInfoSchema,
  LookupResultArraySchema,
} from "./lib/catalog-schemas";

/** Org identity stamped on every row (checkin's Org registry row). */
export interface OrgIdentity {
  id: string;
  name: string;
}

/** The acting checkin person, from the session. Ids in a payload never stand in for this. */
export interface ExpensePrincipal {
  id: number;
  name: string | null;
  isFinance: boolean;
  isBoard: boolean;
}

/** The host's session reader. Null when the caller has no integer person id. */
export interface ExpenseAuth {
  getPrincipal(): Promise<ExpensePrincipal | null>;
}

// ── Budget-owner buckets ──────────────────────────────────────────────────────

/** A budget-owner bucket (checkin's BudgetOwner). */
export interface OwnerInfo {
  id: number;
  name: string;
  archivedAt: Date | null;
}

/** Read-only list of checkin's budget-owner buckets. Same port income and bulk donation declare. */
export interface OwnerDirectory {
  list(): Promise<OwnerInfo[]>;
}

export const inertOwnerDirectory: OwnerDirectory = { list: async () => [] };

/** A bucket's derived approvers: the program's leader and treasurers; none for an org-level bucket. */
export interface BucketApprovers {
  orgLevel: boolean;
  approvers: number[];
}

/**
 * Who may fill a sign-off seat, read from checkin's roles, programs and households. Person ids
 * are checkin Person.id.
 */
export interface SignoffDirectory {
  bucketApprovers(bucketId: number): Promise<BucketApprovers>;
  /** The buckets whose derived approvers include this person (programs led or treasured). */
  bucketsApprovedBy(personId: number): Promise<number[]>;
  financeHolders(): Promise<number[]>;
  boardMembers(): Promise<number[]>;
  /** Everyone in the given people's households. */
  householdOf(personIds: number[]): Promise<number[]>;
  /** Whether the id names a checkin Person. */
  personExists(personId: number): Promise<boolean>;
  /** Whether the purchaser holds an org membership (a non-member's line takes a Board approver). */
  isOrgMember(personId: number): Promise<boolean>;
}

/** Nobody approves, holds a role or is conflicted: no seat can be filled and nothing auto-approves. */
export const inertSignoffDirectory: SignoffDirectory = {
  bucketApprovers: async () => ({ orgLevel: false, approvers: [] }),
  bucketsApprovedBy: async () => [],
  financeHolders: async () => [],
  boardMembers: async () => [],
  householdOf: async () => [],
  personExists: async () => false,
  isOrgMember: async () => false,
};

// ── X3: catalog reads ─────────────────────────────────────────────────────────

export type CatalogCategory = z.infer<typeof CatalogCategorySchema>;
export type CatalogSubcategory = z.infer<typeof CatalogSubcategorySchema>;
export type ItemInfo = NonNullable<z.infer<typeof ItemInfoSchema>>;
export type LookupResult = z.infer<typeof LookupResultArraySchema>[number];

export interface LookupEntry {
  index: number;
  partNumber?: string | null;
  manufacturer?: string | null;
  description?: string | null;
}

/** In-process read of the global catalog. Responses are parsed by the caller (lib/catalog.ts). */
export interface CatalogReader {
  listCategories(): Promise<unknown>;
  listSubcategories(): Promise<unknown>;
  getItem(gtin13: string): Promise<unknown>;
  lookupItems(retailer: string, lookups: LookupEntry[]): Promise<unknown>;
}

/** An empty catalog: every part-numbered line raises a NO_MATCH hold. */
export const inertCatalogReader: CatalogReader = {
  listCategories: async () => [],
  listSubcategories: async () => [],
  getItem: async () => null,
  lookupItems: async () => [],
};

// ── S5: catalog org events ────────────────────────────────────────────────────

/** One catalog OrgEvent row as the catalog's post-commit call-out and catch-up hand it over. */
export const CatalogOrgEventSchema = z.object({
  id: z.number().int().positive(),
  orgId: z.string(),
  eventType: z.string(),
  payload: z.unknown(),
  createdAt: z.coerce.date(),
});
export type CatalogOrgEvent = z.infer<typeof CatalogOrgEventSchema>;

/** Catalog events after a cursor, oldest first; read by the catch-up sweep. */
export interface CatalogEventSource {
  eventsAfter(afterId: number): Promise<unknown[]>;
}

export const inertCatalogEventSource: CatalogEventSource = { eventsAfter: async () => [] };

// ── QuickBooks (QB-1 readers, QB-2 writer) ────────────────────────────────────

/** A QuickBooks Purchase or Bill, reduced to what matching needs. `txnDate` is YYYY-MM-DD. */
export interface QbTxn {
  id: string;
  txnDate: string;
  totalCents: number;
  accountRef: string | null;
  vendorRef: string | null;
}

export interface QbBillPayment {
  id: string;
  txnDate: string;
  billIds: string[];
}

/** Windowed QuickBooks readers; nothing reads QuickBooks since a date. */
export interface QbReader {
  purchasesBetween(from: string, to: string): Promise<QbTxn[]>;
  billsBetween(from: string, to: string): Promise<QbTxn[]>;
  billPaymentsBetween(from: string, to: string): Promise<QbBillPayment[]>;
}

export const inertQbReader: QbReader = {
  purchasesBetween: async () => [],
  billsBetween: async () => [],
  billPaymentsBetween: async () => [],
};

/** The entities expense creates. Never a BillPayment, Check or Payment. */
export type QbCreateEntity = "Purchase" | "Bill" | "Vendor";

/** The create-only QuickBooks writer `@inventory/quickbooks` owns (QB-2). */
export interface QbWriter {
  create(entity: QbCreateEntity, fields: Record<string, unknown>): Promise<{ id: string }>;
}

export const inertQbWriter: QbWriter = {
  create: async () => {
    throw new Error("QuickBooks writer is not bound");
  },
};

// ── Surfaces expense exports to other libraries (bound by the host into theirs) ─

/** S2 callee: the orchestrator hands a completed receipt's money side to expense. */
export interface ExpenseIntake {
  receive(receipt: unknown): Promise<{ receiptId: string; status: "created" | "already_applied" }>;
}

/** FINANCE names the Person owed a reimbursement whose receipt did not carry one. */
export type SetReimbursee = (orgId: string, expenseId: string, personId: number, principal: ExpensePrincipal) => Promise<void>;

/** X12 callee: when QuickBooks recorded each receipt's reimbursement as paid; null = not yet. */
export interface ReimbursementStatus {
  forReceipts(receiptIds: unknown): Promise<Map<string, { paidOn: string | null }>>;
}

/** The org's money thresholds, in cents. Read and updated through services/settingsService. */
export interface ExpenseSettings {
  capitalTotalThresholdCents: number;
  capitalLineItemThresholdCents: number;
  capitalEquipmentUnitCents: number;
  boardReviewTotalCents: number;
  noteInLieuLimitCents: number;
}

// ── Route factories (mounted by the host under its handler()) ──────────────────

/** The slice of a route context a factory consumes: request + path params. */
export interface ExpenseRouteCtx {
  req: Request;
  params: Record<string, string>;
}

/** A route factory's body: parse → service → model bag (stripped by the host). */
export type ExpenseBag = Record<string, unknown>;
export type ExpenseRouteHandler = (ctx: ExpenseRouteCtx) => Promise<ExpenseBag>;
