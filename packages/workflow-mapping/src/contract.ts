/**
 * The injection seam. The host (checkin) implements these and calls
 * configureWorkflowMapping() once; the library never imports the host or a
 * sibling library. Every crossing is one port; flipping a crossing swaps one
 * binding. Unbound ports fall back to the inert adapters below.
 */
import { z } from "zod";
import type {
  CatalogCheckReferences,
  CatalogItemReferenceProposal,
  CatalogItemsLookup,
  CatalogProvisionalItemProposal,
  CatalogReferenceConflict,
  CompletedReceipt,
  ResolvedInventoryDelta,
} from "@inventory/receipt-types";

/** The acting host user. `id` is the host Person.id. */
export interface WorkflowPrincipal {
  id: number;
  name: string | null;
}

export interface OrgIdentity {
  id: string;
  name: string;
}

export interface WorkflowAuth {
  /** The current host user, or null when unauthenticated (including a session with no integer id). */
  getPrincipal(): Promise<WorkflowPrincipal | null>;
}

// ── S4: catalog ──────────────────────────────────────────────────────────────

export const catalogLookupResultSchema = z.object({
  index: z.number(),
  gtin13: z.string().nullable(),
  itemReferenceId: z.number().nullable(),
  conversionFactor: z.number().int().positive(),
  conversionVersion: z.number().int().positive(),
});
export type CatalogLookupResult = z.infer<typeof catalogLookupResultSchema>;

const refInfoSchema = z.object({
  exists: z.boolean(),
  gtin13: z.string().nullable(),
  id: z.number().nullable(),
  conversionFactor: z.number(),
  conversionVersion: z.number(),
});
export const refCheckResultSchema = z.object({
  mfr_part: refInfoSchema,
  retailer_part: refInfoSchema,
  mfr_desc: refInfoSchema,
  wouldCreateNewReference: z.boolean(),
});
export type RefCheckResult = z.infer<typeof refCheckResultSchema>;

export const createdIdSchema = z.object({ id: z.number().int() });
export const gtin13Schema = z.string().min(1);

/** Catalog reads. The adapter stamps the injected org. */
export interface CatalogReader {
  lookupItems(retailer: string, lookups: CatalogItemsLookup["lookups"]): Promise<CatalogLookupResult[]>;
  checkReferences(fields: CatalogCheckReferences): Promise<RefCheckResult>;
}

/** Catalog writes. The adapter stamps the injected org; `localUserId` is the acting Person.id. */
export interface CatalogSubmissions {
  proposeItemReference(p: CatalogItemReferenceProposal): Promise<{ id: number }>;
  reportConflict(p: CatalogReferenceConflict): Promise<{ id: number }>;
  /** Returns the allocated provisional GTIN-13. */
  allocateProvisionalGtin(): Promise<string>;
  proposeProvisionalItem(p: CatalogProvisionalItemProposal): Promise<void>;
}

// ── S2 / X9 / S3: push targets ───────────────────────────────────────────────

/** S2: a purchase receipt's money side. The callee dedupes on `receiptId`. */
export interface ExpenseSink {
  pushReceipt(receipt: CompletedReceipt): Promise<void>;
}

/** X9: an in-kind receipt's money side (instead of expense). The callee dedupes on `receiptId`. */
export interface DonationSink {
  ingestInKind(receipt: CompletedReceipt): Promise<void>;
}

/** S3: load the receipt's goods. The callee applies at most once per source key `receipt:<receiptId>`. */
export interface InventorySink {
  applyDelta(delta: ResolvedInventoryDelta): Promise<void>;
}

// ── S5: catalog org events ───────────────────────────────────────────────────

/** One catalog OrgEvent row; `payload` is its stored JSON body without `eventType`. */
export interface OrgEventRecord {
  id: number;
  orgId: string;
  eventType: string;
  payload: string;
}

/** The shape the catalog's post-commit call-out invokes. */
export interface OrgEventConsumer {
  onOrgEvents(events: OrgEventRecord[]): Promise<void>;
}

/** Replay read: the org's events with id greater than `cursor`, ascending. */
export interface CatalogEventSource {
  eventsSince(orgId: string, cursor: number): Promise<OrgEventRecord[]>;
}

// ── Inert adapters ───────────────────────────────────────────────────────────
// A push target that is not wired throws, so the receipt waits in apply_failed;
// it never reports success with nothing booked or counted.

function notWired(port: string): never {
  throw new Error(`${port} not wired`);
}

export const inertCatalogReader: CatalogReader = {
  lookupItems: async () => [],
  checkReferences: async () => notWired("CatalogReader.checkReferences"),
};

export const inertCatalogSubmissions: CatalogSubmissions = {
  proposeItemReference: async () => notWired("CatalogSubmissions.proposeItemReference"),
  reportConflict: async () => notWired("CatalogSubmissions.reportConflict"),
  allocateProvisionalGtin: async () => notWired("CatalogSubmissions.allocateProvisionalGtin"),
  proposeProvisionalItem: async () => notWired("CatalogSubmissions.proposeProvisionalItem"),
};

export const inertExpenseSink: ExpenseSink = {
  pushReceipt: async () => notWired("ExpenseSink.pushReceipt"),
};

export const inertDonationSink: DonationSink = {
  ingestInKind: async () => notWired("DonationSink.ingestInKind"),
};

export const inertInventorySink: InventorySink = {
  applyDelta: async () => notWired("InventorySink.applyDelta"),
};

export const inertCatalogEventSource: CatalogEventSource = {
  eventsSince: async () => [],
};

export interface WorkflowRuntimeConfig {
  auth: WorkflowAuth;
  /** Accessor, not a frozen value: resolved per call. */
  org: () => OrgIdentity;
  /** Builds the host's HTTP error; the library throws what it returns. */
  httpError: (status: number, message: string) => Error;
  catalogReader?: CatalogReader;
  catalogSubmissions?: CatalogSubmissions;
  expenseSink?: ExpenseSink;
  donationSink?: DonationSink;
  inventorySink?: InventorySink;
  catalogEventSource?: CatalogEventSource;
}
