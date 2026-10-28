"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { notifications } from "@mantine/notifications";
import type { PurchaseOutcomeView } from "../lib/purchaseOutcome";

/**
 * Client fetch helpers. Every receipt read and write goes through the host's routes under
 * /api/receipts; the routes gate and narrow server-side, so the client uses the caller's roles
 * only to decide which controls to show.
 */
export const BASE = "/api/receipts";

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(res.ok ? `Unexpected non-JSON response (HTTP ${res.status})` : `HTTP ${res.status}`);
  }
  if (!res.ok) {
    const message = (data as { error?: unknown } | null)?.error;
    throw new Error(typeof message === "string" ? message : `HTTP ${res.status}`);
  }
  return data as T;
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  return parse<T>(await fetch(`${BASE}${path}`, { headers: { "Content-Type": "application/json" }, ...options }));
}

/**
 * Multipart upload; the browser sets the boundary header. A success tells the host nav to
 * refetch its pills, since the new receipt may already wait on its uploader.
 */
export async function upload<T>(form: FormData): Promise<T> {
  const receipt = await parse<T>(await fetch(`${BASE}/upload`, { method: "POST", body: form }));
  window.dispatchEvent(new Event("nav-counts-mutated"));
  return receipt;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : "Error";
}

/**
 * Sends a write, toasts the outcome, and reports whether it succeeded. A success tells the
 * host nav to refetch its pills, since a write can move a receipt into or out of the caller's hands.
 * A failure stays on screen until dismissed, titled `failed` with the server's reason below it.
 */
export async function send(path: string, method: string, body: unknown, success: string, failed: string): Promise<boolean> {
  try {
    await api(path, { method, body: JSON.stringify(body) });
    window.dispatchEvent(new Event("nav-counts-mutated"));
    notifications.show({ message: success, color: "green" });
    return true;
  } catch (err) {
    notifications.show({ title: failed, message: errorMessage(err), color: "red", autoClose: false });
    return false;
  }
}

/** The caller's finance roles, read through a narrow cast of the host's session user. */
export function useRoles(): { isFinance: boolean; isBoard: boolean } {
  const { data } = useSession();
  const user = data?.user as { isFinance?: boolean; isBoardMember?: boolean } | undefined;
  return { isFinance: user?.isFinance === true, isBoard: user?.isBoardMember === true };
}

export interface Loaded<T> {
  data: T | null;
  error: string | null;
  reload: () => void;
}

/** Load `path` on mount and on reload(); null loads nothing. A stale response never overwrites a newer one. */
export function useLoad<T>(path: string | null): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  useEffect(() => {
    if (path === null) return;
    const mine = ++seq.current;
    api<T>(path)
      .then((d) => { if (mine === seq.current) { setData(d); setError(null); } })
      .catch((e: unknown) => { if (mine === seq.current) setError(errorMessage(e)); });
  }, [path, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, reload };
}

export const dollars = (cents: number | null | undefined) => (cents == null ? "—" : `$${(cents / 100).toFixed(2)}`);

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
