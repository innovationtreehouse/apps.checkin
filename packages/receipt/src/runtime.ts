import type {
  DonorSink,
  OcrProvider,
  ReceiptConfig,
  ReceiptFileStore,
  MailboxReader,
  ReceiptHouseholds,
  ReceiptAlerts,
  ReceiptPeople,
  ReceiptReplies,
  ReceiptReimbursees,
  ReceiptPrincipal,
  ReceiptSink,
  PurchaseOutcomes,
  ReimbursementStatus,
  SubmitterConfirmations,
} from "./contract";
import { NotWiredError, callerId, defineRuntime } from "@checkin/component-kit";
import { DEFAULT_LIMITS, type ReceiptLimits } from "./lib/limits";

export { NotWiredError };

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

/** Knows nothing downstream: every finalized receipt reads as not yet received. */
export const inertPurchaseOutcomes: PurchaseOutcomes = {
  forReceipts: async () => new Map(),
};

/** Knows no expense: nothing waits on a submitter there, and a confirmation is not delivered. */
export const inertSubmitterConfirmations: SubmitterConfirmations = {
  awaiting: async () => [],
  confirm: async () => {
    throw new NotWiredError("SubmitterConfirmations.confirm");
  },
  confirmable: async () => [],
};

/** Knows no households: only the uploader and the reimbursee themselves are refused. */
export const inertHouseholds: ReceiptHouseholds = {
  householdOf: async () => [],
};

/** Knows nobody: every mailed receipt is held for finance. */
export const inertPeople: ReceiptPeople = {
  submitterByEmail: async () => null,
};

/** Knows nobody: only the uploader can be reimbursed until the host binds its people. */
export const inertReimbursees: ReceiptReimbursees = {
  search: async () => [],
  byId: async () => null,
  hasAccount: async () => true,
  addNonMemberAdult: async () => {
    throw new Error("No people directory is bound to add a person");
  },
};

/** Logs the alert: nothing reaches finance until the host binds alerts. */
export const inertAlerts: ReceiptAlerts = {
  mailHoldCeilingReached: async (event) => {
    console.warn("[receipt] mail hold ceiling reached; finance alerts are not bound:", event);
  },
  mailAgingOut: async (event) => {
    console.warn("[receipt] mail is leaving the window unread; finance alerts are not bound:", event);
  },
  mailListingFailed: async (event) => {
    console.warn("[receipt] the mailbox could not be listed; finance alerts are not bound:", event);
  },
};

export const inertOcr: OcrProvider = {
  extract: async () => ({ success: false, error: "OCR is not configured" }),
};

export const inertFileStore: ReceiptFileStore = {
  put: async () => {
    throw new NotWiredError("ReceiptFileStore.put");
  },
  get: async () => {
    throw new NotWiredError("ReceiptFileStore.get");
  },
  delete: async () => {
    throw new NotWiredError("ReceiptFileStore.delete");
  },
};

export const receiptRuntime = defineRuntime<ReceiptConfig, ReceiptPrincipal>("receipt");
const requireRuntime = receiptRuntime.require;

export const configureReceipt = receiptRuntime.configure;

export const getOrgId = receiptRuntime.getOrgId;

export function limits(): ReceiptLimits {
  return { ...DEFAULT_LIMITS, ...requireRuntime().limits };
}

export function ports(): Required<Omit<ReceiptConfig, "auth" | "org" | "limits" | "mailbox" | "replies" | "fileStore" | "storeNewFilesInBucket">> {
  const r = requireRuntime();
  return {
    receiptSink: r.receiptSink ?? inertReceiptSink,
    donorSink: r.donorSink ?? inertDonorSink,
    reimbursementStatus: r.reimbursementStatus ?? inertReimbursementStatus,
    submitterConfirmations: r.submitterConfirmations ?? inertSubmitterConfirmations,
    purchaseOutcomes: r.purchaseOutcomes ?? inertPurchaseOutcomes,
    households: r.households ?? inertHouseholds,
    ocr: r.ocr ?? inertOcr,
    people: r.people ?? inertPeople,
    reimbursees: r.reimbursees ?? inertReimbursees,
    alerts: r.alerts ?? inertAlerts,
  };
}

export function fileStore(): ReceiptFileStore {
  return requireRuntime().fileStore ?? inertFileStore;
}

export function storesNewFilesInBucket(): boolean {
  return requireRuntime().storeNewFilesInBucket === true;
}

/** The receipt mailbox, or null when mail intake is unbound. */
export function mailbox(): MailboxReader | null {
  return requireRuntime().mailbox ?? null;
}

/** The host's mail out for acknowledgements, or null when unbound. */
export function replies(): ReceiptReplies | null {
  return requireRuntime().replies ?? null;
}

export { callerId };

/** The authenticated actor, or a 401 when there is none or it has no integer id. */
export const requireActor = receiptRuntime.getPrincipal;
