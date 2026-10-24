/**
 * The injection seam. The host (checkin) implements these and calls configureReceipt()
 * once; the library never imports the host or a sibling library. Every crossing is one
 * port; flipping a crossing swaps one binding. Unbound ports fall back to the inert
 * adapters in runtime.ts.
 */
import { z } from "zod";
import { MAX_LINE_QUANTITY, type CompletedReceipt } from "@checkin/receipt-types";
import type { ReceiptLimits } from "./lib/limits";

/** The acting host user, projected from the checkin Person. `id` is the Person.id. */
export interface ReceiptPrincipal {
  id: number;
  name: string | null;
  firstName: string;
  lastName: string;
  isAdult: boolean;
  /** Mailed receipts get the raised daily limit (a program lead or Board member); set by the sender lookup. */
  raisedMailLimit?: boolean;
  /** A Board member, who confirms a reimbursement on behalf of a reimbursee with no account. */
  isBoardMember?: boolean;
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

/** An owed receipt; a backfilled one names the hand-booked QuickBooks transaction it matched. */
export type ReimbursementAsk = { receiptId: string; qbEntity: string | null; qbTxnId: string | null };

/** X12. QuickBooks is the system of record; a receipt missing from the answer is not yet paid. */
export interface ReimbursementStatus {
  forReceipts(receipts: ReimbursementAsk[]): Promise<Map<string, PaidStatus>>;
}

// ── Submitter confirmations ← expense ──────────────────────────────────────

/** A reimbursement whose expense waits for the person reimbursed to confirm its receipt. */
export interface AwaitedConfirmation {
  receiptId: string;
  reimburseePersonId: number;
  /** The fields of the finance change that cleared the last confirmation; empty when none was given. */
  changedFields: string[];
}

/**
 * The submitter's signature on a reimbursement whose expense exists, given by the person
 * reimbursed. Finance changing what was claimed or is paid clears it there, and it is given again.
 */
export interface SubmitterConfirmations {
  /** The org's reimbursements whose expense waits for the confirmation. */
  awaiting(): Promise<AwaitedConfirmation[]>;
  /**
   * Records the confirmation on every line of the receipt's expense still waiting for it, signed by
   * `signer`: the reimbursee, or a Board member on their behalf giving `reason`. False when none waits.
   */
  confirm(receiptId: string, reimburseePersonId: number, signer: { id: number; name: string | null }, reason: string | null): Promise<boolean>;
}

/** The host's households, for the rule that nobody decides a receipt their household is party to. */
export interface ReceiptHouseholds {
  /** Everyone in the given people's households. */
  householdOf(personIds: number[]): Promise<number[]>;
}

// ── OCR provider ─────────────────────────────────────────────────────────────

// OCR output is untrusted: it carries the manual-entry bounds, and money stays inside the
// int4 cents columns.
const MAX_DOLLARS = 10_000_000;
const ocrMoney = z.number().finite().nonnegative().max(MAX_DOLLARS);

export const OcrLineItemSchema = z.object({
  description: z.string().min(1).max(500),
  partNumber: z.string().max(100).optional(),
  manufacturer: z.string().max(100).optional(),
  quantity: z.number().finite().positive().max(MAX_LINE_QUANTITY),
  unitPrice: ocrMoney,
  isDelayed: z.boolean(),
});

/** What OCR may fill: the receipt's own details. Never reimbursee, vendor or needsReimbursement. */
export const OcrDataSchema = z.object({
  retailer: z.string().max(500),
  receiptNumber: z.string().max(200).optional(),
  orderNumber: z.string().max(200).optional(),
  receiptDate: z.string().max(50),
  currency: z.string().max(10),
  shipping: ocrMoney,
  tax: ocrMoney,
  discount: ocrMoney,
  receiptTotal: ocrMoney,
  receiptTotalText: z.string().max(100).optional(),
  lineItems: z.array(OcrLineItemSchema).max(200),
});
export type OcrLineItem = z.infer<typeof OcrLineItemSchema>;
export type OcrData = z.infer<typeof OcrDataSchema>;

export type OcrResult = { success: true; data: OcrData } | { success: false; error: string };

/** Reads a stored receipt file. Never throws: every failure is `{ success: false }`. */
export interface OcrProvider {
  extract(file: Buffer, mimeType: string): Promise<OcrResult>;
}

// ── Mail intake (phase G) ────────────────────────────────────────────────────

/** The host's people, for attributing a mailed receipt to its sender. */
export interface ReceiptPeople {
  /** The one live person allowed to submit receipts whose sign-in email is exactly this address, else null. */
  submitterByEmail(address: string): Promise<ReceiptPrincipal | null>;
}

/** A person the uploader may name as reimbursee. `id` is the Person.id. */
export interface ReimburseeOption {
  id: number;
  name: string;
}

/** The host's people an uploader may name as reimbursee. Only an adult is reimbursed. */
export interface ReceiptReimbursees {
  /** Live adults whose name contains `query`, at most `limit` of them. */
  search(query: string, limit: number): Promise<ReimburseeOption[]>;
  /** The live person with this id and whether they are a known adult, else null. */
  byId(personId: number): Promise<(ReimburseeOption & { isAdult: boolean }) | null>;
  /** Whether this person has an account to sign in with, and so confirms for themself. */
  hasAccount(personId: number): Promise<boolean>;
}

export const MailPartSchema: z.ZodType<MailPart> = z.lazy(() =>
  z.object({
    mimeType: z.string(),
    filename: z.string().optional(),
    headers: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
    body: z.object({ data: z.string().optional(), attachmentId: z.string().optional(), size: z.number().optional() }).optional(),
    parts: z.array(MailPartSchema).optional(),
  }),
);

/** One MIME part as the Gmail API's `format=full` returns it; `body.data` is base64url. */
export interface MailPart {
  mimeType: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: MailPart[];
}

export const MailMessageSchema = z.object({ id: z.string().min(1), internalDate: z.string().regex(/^\d+$/), payload: MailPartSchema });
export type MailMessage = z.infer<typeof MailMessageSchema>;

/** Read-only access to the receipt mailbox. */
export interface MailboxReader {
  /** Ids of messages received in the last `days` days, oldest first. Mail the mailbox sent is not listed. */
  listRecent(days: number): Promise<string[]>;
  getMessage(id: string): Promise<MailMessage>;
  getAttachment(messageId: string, attachmentId: string): Promise<Buffer>;
}

/** Mail intake stopped storing mail because too many held or deferred items are stored. */
export interface MailHoldCeilingEvent {
  orgId: string;
  /** Held and deferred items stored when the run stopped storing. */
  unresolved: number;
  /** Files this run did not hold. */
  refused: number;
}

/** Finance alerts the host binds. */
export interface ReceiptAlerts {
  mailHoldCeilingReached(event: MailHoldCeilingEvent): Promise<void>;
}

export interface ReceiptConfig {
  auth: ReceiptAuth;
  /** Async accessor, resolved per call: the host may read the org from its own store. */
  org: () => Promise<OrgIdentity>;
  receiptSink?: ReceiptSink;
  donorSink?: DonorSink;
  reimbursementStatus?: ReimbursementStatus;
  submitterConfirmations?: SubmitterConfirmations;
  households?: ReceiptHouseholds;
  ocr?: OcrProvider;
  people?: ReceiptPeople;
  reimbursees?: ReceiptReimbursees;
  alerts?: ReceiptAlerts;
  /** Unset means mail intake is unbound and the step does nothing. */
  mailbox?: MailboxReader;
  /** Overrides for the daily intake limits; unset ones keep DEFAULT_LIMITS. */
  limits?: Partial<ReceiptLimits>;
}
