"use client";
import { createClient, errorMessage, notifyNavCounts, request, useViewer } from "@checkin/component-ui";
import { notifications } from "@mantine/notifications";
import type { PurchaseOutcomeView } from "../lib/purchaseOutcome";

/**
 * Client fetch helpers. Every receipt read and write goes through the host's routes under
 * /api/receipts; the routes gate and narrow server-side, so the client uses the caller's roles
 * only to decide which controls to show.
 */
export const BASE = "/api/receipts";

export const { api, useLoad } = createClient(BASE);

/**
 * Multipart upload; the browser sets the boundary header. A success tells the host nav to
 * refetch its pills, since the new receipt may already wait on its uploader.
 */
export async function upload<T>(form: FormData): Promise<T> {
  const receipt = await request<T>(`${BASE}/upload`, { method: "POST", body: form });
  notifyNavCounts();
  return receipt;
}

/**
 * Sends a write, toasts the outcome, and reports whether it succeeded. A success tells the
 * host nav to refetch its pills, since a write can move a receipt into or out of the caller's hands.
 * A failure stays on screen until dismissed, titled `failed` with the server's reason below it.
 */
export async function send(path: string, method: string, body: unknown, success: string, failed: string): Promise<boolean> {
  try {
    await api(path, { method, body: JSON.stringify(body) });
    notifyNavCounts();
    notifications.show({ message: success, color: "green" });
    return true;
  } catch (err) {
    notifications.show({ title: failed, message: errorMessage(err), color: "red", autoClose: false });
    return false;
  }
}

/** The viewer's finance roles. */
export function useRoles(): { isFinance: boolean; isBoard: boolean } {
  const viewer = useViewer();
  return { isFinance: viewer?.isFinance === true, isBoard: viewer?.isBoardMember === true };
}

export { errorMessage, type Loaded } from "@checkin/component-ui";

/** A receipt row as the routes return it (fields the caller's view does not grant are absent). */
export interface ReceiptListRow {
  id: string;
  uploadedAt: string;
  uploadedByUserId: number;
  retailer: string | null;
  receiptDate: string | null;
  receiptTotalCents: number | null;
  state: string;
  needsReimbursement: boolean;
  isInKind: boolean;
  validationNotes?: string | null;
  pushedAt?: string | null;
  /** `statusUnavailable`: QuickBooks could not say whether it was paid. */
  reimbursement?: { paidOn: string | null; statusUnavailable?: boolean } | null;
  complete?: boolean;
  reimburseePersonId?: number | null;
  /** On a finalized receipt not yet delivered to receiving: catch-up has stopped retrying it. */
  pushGivenUp?: boolean;
  lastPushFailedAt?: string | null;
  lastPushFailure?: string | null;
  duplicateFlaggedAt?: string | null;
  duplicateFlagClearedAt?: string | null;
  /** The receipt this one was flagged against; finance views only. */
  duplicateSuspectReceiptId?: string | null;
  /** On a receipt rejected as a copy, in finance's list: the receipt kept in its place. */
  copyOfId?: string | null;
  copyOfLabel?: string | null;
  /** In the uploader's views: a rejected receipt they have not yet acknowledged. */
  rejectionUnacknowledged?: boolean;
  /** On a finalized receipt in the uploader's views: where its purchase stands downstream. */
  purchaseOutcome?: PurchaseOutcomeView;
}

/** A reimbursement waiting for the caller's confirmation, as the person reimbursed or a Board member on their behalf. */
export interface ReceiptConfirmation {
  id: string;
  state: string;
  retailer: string | null;
  receiptDate: string | null;
  currency: string;
  shippingCents: number;
  taxCents: number;
  discountCents: number;
  receiptTotalCents: number | null;
  onBehalf: boolean;
  /** The fields of the finance change that cleared the last confirmation; empty when none was given. */
  changedFields: string[];
  lineItems: Array<{ id: number; lineNumber: number; description: string; quantity: number; totalPriceCents: number; isDelayed: boolean }>;
}

export { isDiscardedDuplicate, receiptStateLabel, STATE_LABELS } from "../lib/stateLabels";
export { latestOutcome, outcomeSteps, type OutcomeStep, type PurchaseOutcomeView } from "../lib/purchaseOutcome";
