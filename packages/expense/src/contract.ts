// Ports the host (checkin-app) binds via configureExpense(). Every port has an inert adapter
// here; an unbound port behaves as that adapter, so nothing reaches another library, checkin
// or QuickBooks until the host binds it.
import { z } from "zod";
import type { QuickBooksClient } from "@checkin/quickbooks";
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
  /** The bucket's QuickBooks Class; an expense line in a bucket without one is not posted. */
  quickBooksClassId: string | null;
}

/** Read-only list of checkin's budget-owner buckets. Same port income and bulk donation declare. */
export interface OwnerDirectory {
  list(): Promise<OwnerInfo[]>;
}

export const inertOwnerDirectory: OwnerDirectory = { list: async () => [] };

/** A bucket's approvers: its owner and treasurers; none for an org-level bucket. */
export interface BucketApprovers {
  orgLevel: boolean;
  approvers: number[];
  /** The bucket's owner, eligible to sign or not; null for an org-level bucket or one without an owner. */
  owner: number | null;
}

/**
 * Who may fill a sign-off seat, read from checkin's roles, programs and households. Person ids
 * are checkin Person.id.
 */
export interface SignoffDirectory {
  bucketApprovers(bucketId: number): Promise<BucketApprovers>;
  /** The buckets whose approvers (owner or treasurer) include this person. */
  bucketsApprovedBy(personId: number): Promise<number[]>;
  financeHolders(): Promise<number[]>;
  boardMembers(): Promise<number[]>;
  /** Everyone in the given people's households. */
  householdOf(personIds: number[]): Promise<number[]>;
  /** Whether the id names a checkin Person. */
  personExists(personId: number): Promise<boolean>;
  /** The live Person an id resolves to: itself when live, its merge survivor when merged away, else null. */
  livePersonFor(personId: number): Promise<number | null>;
  /** Whether the person holds an org membership (reimbursing a non-member takes a Board approver). */
  isOrgMember(personId: number): Promise<boolean>;
}

/** Nobody approves, holds a role or is conflicted: no seat can be filled and nothing auto-approves. */
export const inertSignoffDirectory: SignoffDirectory = {
  bucketApprovers: async () => ({ orgLevel: false, approvers: [], owner: null }),
  bucketsApprovedBy: async () => [],
  financeHolders: async () => [],
  boardMembers: async () => [],
  householdOf: async () => [],
  personExists: async () => false,
  livePersonFor: async () => null,
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

/** A Bill's paid state: `balance` 0 means paid (null = not reported); `paymentIds` are its linked BillPayments. */
export interface QbBillBalance {
  id: string;
  txnDate: string;
  balance: number | null;
  paymentIds: string[];
}

/** Windowed and by-id QuickBooks readers; nothing reads QuickBooks since a date. */
export interface QbReader {
  purchasesBetween(from: string, to: string): Promise<QbTxn[]>;
  billsBetween(from: string, to: string): Promise<QbTxn[]>;
  billPaymentsBetween(from: string, to: string): Promise<QbBillPayment[]>;
  purchasesByIds(ids: string[]): Promise<QbTxn[]>;
  billsByIds(ids: string[]): Promise<QbBillBalance[]>;
  billPaymentsByIds(ids: string[]): Promise<{ id: string; txnDate: string }[]>;
}

export const inertQbReader: QbReader = {
  purchasesBetween: async () => [],
  billsBetween: async () => [],
  billPaymentsBetween: async () => [],
  purchasesByIds: async () => [],
  billsByIds: async () => [],
  billPaymentsByIds: async () => [],
};

/**
 * The QuickBooks ids an expense entry is booked against: the payment account of a Purchase and
 * the reimbursee's vendor on a Bill. A candidate must carry the same id; null means unknown, and
 * then nothing matches.
 */
export interface QbRefs {
  paymentAccountId(): Promise<string | null>;
  vendorIdFor(personId: number): Promise<string | null>;
}

export const inertQbRefs: QbRefs = {
  paymentAccountId: async () => null,
  vendorIdFor: async () => null,
};

/** A QuickBooks Vendor offered to finance for a reimbursee. */
export interface QbVendorOption {
  id: string;
  displayName: string;
}

/** Finance's Vendor reads and create, on a live QuickBooks connection. */
export interface QbVendorClient {
  /** Active Vendors whose name contains the text. */
  search(text: string): Promise<QbVendorOption[]>;
  byId(id: string): Promise<QbVendorOption | null>;
  /** An existing Vendor with that name is returned (`created: false`), not created again. */
  findOrCreate(name: string, key: string): Promise<QbVendorOption & { created: boolean }>;
}

/** The connection, or null while QuickBooks is off for this deployment. */
export interface QbVendors {
  open(): Promise<QbVendorClient | null>;
}

export const inertQbVendors: QbVendors = { open: async () => null };

/** Display names of checkin people. */
export interface PeopleDirectory {
  /** A live person's name; null when unknown. */
  nameOf(personId: number): Promise<string | null>;
}

export const inertPeopleDirectory: PeopleDirectory = { nameOf: async () => null };

/** Rows keyed by model name, as they go into or come out of the outbound gateway. */
export type OutboundBag = Record<string, unknown>;

/**
 * The host's outbound gateway: strips `bag` to the surface's declared tiers, and `send` sees only
 * the stripped rows. Every QuickBooks write is built inside `send`.
 */
export type Outbound = <T>(surface: string, bag: OutboundBag, send: (stripped: OutboundBag) => Promise<T>) => Promise<T>;

export const inertOutbound: Outbound = async (surface) => {
  throw new Error(`no outbound gateway is bound: nothing is sent to ${surface}`);
};

/**
 * QB-2 posting: the host's QuickBooks client (the create-only writer lives in
 * `@checkin/quickbooks`) and the card or bank account a non-reimbursement expense is paid from.
 */
export interface ExpensePosting {
  client: QuickBooksClient;
  paymentAccountId: string;
  paymentType: "Cash" | "CreditCard";
  /**
   * YYYY-MM-DD: finance booked everything up to here by hand, so only later receipts may be
   * created. Null posts nothing. A newer hand-booked match moves the line later, never earlier.
   */
  takeoverDate: string | null;
  /** CHECKIN_ENV is prod. Outside prod only an isTestData expense from a "TEST-" vendor posts; prod never posts one. */
  prod: boolean;
}

// ── Surfaces expense exports to other libraries (bound by the host into theirs) ─

/** S2 callee: the orchestrator hands a completed receipt's money side to expense. */
export interface ExpenseIntake {
  receive(receipt: unknown): Promise<{ receiptId: string; status: "created" | "already_applied" }>;
}

/** FINANCE names the Person owed a reimbursement whose receipt did not carry one. */
export type SetReimbursee = (orgId: string, expenseId: string, personId: number, principal: ExpensePrincipal) => Promise<void>;

/**
 * X12 callee: when QuickBooks recorded each receipt's reimbursement as paid; null = not yet.
 * A backfilled receipt names the hand-booked transaction it matched (`qbEntity` + `qbTxnId`).
 */
export interface ReimbursementStatus {
  forReceipts(receipts: unknown): Promise<Map<string, { paidOn: string | null }>>;
}

/**
 * Receipt callee: the reimbursement submitter's signature, recorded on the expense from their
 * confirmation of the receipt, and given again after a finance change clears it.
 */
export interface SubmitterConfirmations {
  awaiting(personId: number): Promise<Map<string, string[]>>;
  confirm(receiptId: string, person: { id: number; name: string | null }): Promise<boolean>;
}

/** The org's money thresholds, in cents. Read and updated through services/settingsService. */
export interface ExpenseSettings {
  capitalTotalThresholdCents: number;
  capitalLineItemThresholdCents: number;
  capitalEquipmentUnitCents: number;
  boardReviewTotalCents: number;
  everydayTotalLimitCents: number;
  everydayItemLimitCents: number;
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
