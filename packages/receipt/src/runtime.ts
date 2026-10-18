import type {
  DonorSink,
  OcrProvider,
  OrgIdentity,
  ReceiptConfig,
  MailboxReader,
  ReceiptHouseholds,
  ReceiptAlerts,
  ReceiptPeople,
  ReceiptPrincipal,
  ReceiptSink,
  ReimbursementStatus,
} from "./contract";
import { ServiceError } from "@checkin/component-kit";
import { DEFAULT_LIMITS, type ReceiptLimits } from "./lib/limits";

/** Thrown by an inert port: the crossing is declared but not bound yet. Callers retry later. */
export class NotWiredError extends Error {
  constructor(port: string) {
    super(`${port} is not wired`);
    this.name = "NotWiredError";
  }
}

// Inert means queue, never pretend: unbound pushes throw so the receipt waits for a retry.
export const inertReceiptSink: ReceiptSink = {
  ingestReceipt: async () => {
    throw new NotWiredError("ReceiptSink (X6)");
  },
};

export const inertDonorSink: DonorSink = {
  recordInKindDonor: async () => {
    throw new NotWiredError("DonorSink.recordInKindDonor (X13)");
  },
  withdrawInKind: async () => {
    throw new NotWiredError("DonorSink.withdrawInKind (X13)");
  },
};

/** Never claims a payment: every receipt reads "not yet paid" until X12 is bound. */
export const inertReimbursementStatus: ReimbursementStatus = {
  forReceipts: async (receipts) => new Map(receipts.map((r) => [r.receiptId, { paidOn: null }])),
};

/** Knows no households: only the uploader and the reimbursee themselves are refused. */
export const inertHouseholds: ReceiptHouseholds = {
  householdOf: async () => [],
};

/** Knows nobody: every mailed receipt is held for finance. */
export const inertPeople: ReceiptPeople = {
  submitterByEmail: async () => null,
};

/** Logs the alert: nothing reaches finance until the host binds alerts. */
export const inertAlerts: ReceiptAlerts = {
  mailHoldCeilingReached: async (event) => {
    console.warn("[receipt] mail hold ceiling reached; finance alerts are not bound:", event);
  },
};

export const inertOcr: OcrProvider = {
  extract: async () => ({ success: false, error: "OCR is not configured" }),
};

// ponytail: one runtime per process, on globalThis so HMR and split chunks share it.
const globalForRuntime = globalThis as typeof globalThis & { __receiptRuntime?: ReceiptConfig };

export function configureReceipt(config: ReceiptConfig): void {
  globalForRuntime.__receiptRuntime = config;
}

function requireRuntime(): ReceiptConfig {
  const runtime = globalForRuntime.__receiptRuntime;
  if (!runtime) throw new Error("receipt runtime not configured — the host must call configureReceipt()");
  return runtime;
}

export function getOrg(): Promise<OrgIdentity> {
  return requireRuntime().org();
}

export function limits(): ReceiptLimits {
  return { ...DEFAULT_LIMITS, ...requireRuntime().limits };
}

export function ports(): Required<Omit<ReceiptConfig, "auth" | "org" | "limits" | "mailbox">> {
  const r = requireRuntime();
  return {
    receiptSink: r.receiptSink ?? inertReceiptSink,
    donorSink: r.donorSink ?? inertDonorSink,
    reimbursementStatus: r.reimbursementStatus ?? inertReimbursementStatus,
    households: r.households ?? inertHouseholds,
    ocr: r.ocr ?? inertOcr,
    people: r.people ?? inertPeople,
    alerts: r.alerts ?? inertAlerts,
  };
}

/** The receipt mailbox, or null when mail intake is unbound. */
export function mailbox(): MailboxReader | null {
  return requireRuntime().mailbox ?? null;
}

/** The acting Person.id. Throws on anything but an integer. */
export function callerId(principal: { id: unknown }): number {
  const { id } = principal;
  if (typeof id !== "number" || !Number.isInteger(id)) throw new ServiceError(401, "Unauthorized");
  return id;
}

/** The authenticated actor, or a 401 when there is none or it has no integer id. */
export async function requireActor(): Promise<ReceiptPrincipal> {
  const principal = await requireRuntime().auth.getPrincipal();
  if (!principal) throw new ServiceError(401, "Unauthorized");
  return { ...principal, id: callerId(principal) };
}
