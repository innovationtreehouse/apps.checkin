/**
 * The injection seam. The host (checkin) implements these and calls configureReceipt()
 * once; the library never imports the host or a sibling library. Every crossing is one
 * port; flipping a crossing swaps one binding. Unbound ports fall back to the inert
 * adapters in runtime.ts.
 */
import { z } from "zod";
import type { CompletedReceipt } from "@inventory/receipt-types";

/** The acting host user, projected from the checkin Person. `id` is the Person.id. */
export interface ReceiptPrincipal {
  id: number;
  name: string | null;
  firstName: string;
  lastName: string;
  isAdult: boolean;
}

export interface ReceiptAuth {
  /** The current host user, or null when unauthenticated (including a session with no integer id). */
  getPrincipal(): Promise<ReceiptPrincipal | null>;
}

export interface OrgIdentity {
  id: string;
  name: string;
}

// ── X6 / S1: receipt → workflow-mapping ──────────────────────────────────────

export const ingestResultSchema = z.object({
  id: z.number().int(),
  state: z.string(),
  created: z.boolean(),
});
export type IngestResult = z.infer<typeof ingestResultSchema>;

/** S1 push. The callee dedupes on `receiptId`; a replay answers `created: false`. A throw means not delivered. */
export interface ReceiptSink {
  ingestReceipt(receipt: CompletedReceipt): Promise<IngestResult>;
}

// ── X13: in-kind donor → donations ───────────────────────────────────────────

export const InKindDonorSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  companyName: z.string().nullable(),
});
export type InKindDonor = z.infer<typeof InKindDonorSchema>;

/** X13. Both calls are idempotent on `receiptId`; a later recordInKindDonor replaces the donor. */
export interface DonorSink {
  recordInKindDonor(orgId: string, receiptId: string, donor: InKindDonor): Promise<void>;
  withdrawInKind(orgId: string, receiptId: string): Promise<void>;
}

// ── X12: reimbursement status ← expense ──────────────────────────────────────

export const reimbursementStatusSchema = z.map(z.string(), z.object({ paidOn: z.string().nullable() }));
export type PaidStatus = { paidOn: string | null };

/** X12. QuickBooks is the system of record; a receipt missing from the answer is not yet paid. */
export interface ReimbursementStatus {
  forReceipts(receiptIds: string[]): Promise<Map<string, PaidStatus>>;
}

// ── OCR provider ─────────────────────────────────────────────────────────────

export const OcrLineItemSchema = z.object({
  description: z.string(),
  partNumber: z.string().optional(),
  manufacturer: z.string().optional(),
  quantity: z.number().finite().positive(),
  unitPrice: z.number().finite(),
  isDelayed: z.boolean(),
});

/** What OCR may fill: the receipt's own details. Never reimbursee, vendor or needsReimbursement. */
export const OcrDataSchema = z.object({
  retailer: z.string(),
  receiptNumber: z.string().optional(),
  orderNumber: z.string().optional(),
  receiptDate: z.string(),
  currency: z.string(),
  shipping: z.number().finite(),
  tax: z.number().finite(),
  discount: z.number().finite(),
  receiptTotal: z.number().finite(),
  receiptTotalText: z.string().optional(),
  lineItems: z.array(OcrLineItemSchema),
});
export type OcrLineItem = z.infer<typeof OcrLineItemSchema>;
export type OcrData = z.infer<typeof OcrDataSchema>;

export type OcrResult = { success: true; data: OcrData } | { success: false; error: string };

/** Reads a stored receipt file. Never throws: every failure is `{ success: false }`. */
export interface OcrProvider {
  extract(file: Buffer, mimeType: string): Promise<OcrResult>;
}

export interface ReceiptConfig {
  auth: ReceiptAuth;
  /** Async accessor, resolved per call: the host may read the org from its own store. */
  org: () => Promise<OrgIdentity>;
  receiptSink?: ReceiptSink;
  donorSink?: DonorSink;
  reimbursementStatus?: ReimbursementStatus;
  ocr?: OcrProvider;
}
