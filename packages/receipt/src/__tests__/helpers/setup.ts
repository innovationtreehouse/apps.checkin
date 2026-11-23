import { KindedError } from "@checkin/component-kit";
import type { CompletedReceipt } from "@checkin/receipt-types";
import { db } from "../../db";
import type { FailureKind } from "@checkin/component-kit";
import type { InKindDonor, OcrProvider, ReceiptConfig, ReceiptPrincipal } from "../../contract";
import { createMemoryFileStore, newMailItemFileKey, receiptFileKey, sha256Hex } from "../../lib/fileStorage";
import { configureReceipt, fileStore } from "../../runtime";
import { readsInFlight, receiptService } from "../../services/receiptService";

export const TEST_ORG_ID = "00000000-0000-0000-0000-000000000001";

export const ALICE: ReceiptPrincipal = { id: 101, name: "alice", firstName: "Alice", lastName: "Adams", isAdult: true };
export const BOB: ReceiptPrincipal = { id: 102, name: "bob", firstName: "Bob", lastName: "Baker", isAdult: true };
export const FINANCE: ReceiptPrincipal = { id: 900, name: "finn", firstName: "Finn", lastName: "Ance", isAdult: true };
export const MINOR: ReceiptPrincipal = { id: 103, name: "kid", firstName: "Kit", lastName: "Kid", isAdult: false };

/** The acting principal; tests switch it with `actAs`. */
let current: ReceiptPrincipal | null = ALICE;
export function actAs(p: ReceiptPrincipal | null): void {
  current = p;
}

/** Records what reaches each port; succeeds unless told to fail. `true` is an outage; an Error is thrown as given. */
export function recordingPorts() {
  const calls = {
    pushes: [] as CompletedReceipt[],
    donors: [] as Array<{ orgId: string; receiptId: string; donor: InKindDonor; seq: number }>,
    withdrawals: [] as Array<{ orgId: string; receiptId: string; seq: number }>,
  };
  const fail: { push: boolean | Error; donor: boolean | Error } = { push: false, donor: false };
  const failDonor = () => {
    if (fail.donor instanceof Error) throw fail.donor;
    if (fail.donor) throw new KindedError("system", "donations down");
  };
  return {
    calls,
    fail,
    receiptSink: {
      ingestReceipt: async (r: CompletedReceipt) => {
        calls.pushes.push(r);
        if (fail.push instanceof Error) throw fail.push;
        if (fail.push) throw new KindedError("system", "workflow-mapping down");
        return { id: calls.pushes.length, state: "pending_review", created: true };
      },
    },
    donorSink: {
      recordInKindDonor: async (orgId: string, receiptId: string, donor: InKindDonor, seq: number) => {
        calls.donors.push({ orgId, receiptId, donor, seq });
        failDonor();
      },
      withdrawInKind: async (orgId: string, receiptId: string, seq: number) => {
        calls.withdrawals.push({ orgId, receiptId, seq });
        failDonor();
      },
    },
  };
}

/** The store every test uses unless it binds its own; it outlives a re-configure and is emptied by clearAll. */
const testStore = createMemoryFileStore();

export function configure(overrides: Partial<ReceiptConfig> = {}): void {
  current = ALICE;
  configureReceipt({
    auth: { getPrincipal: async () => current },
    org: async () => ({ id: TEST_ORG_ID, name: "Test Org" }),
    fileStore: testStore,
    rawMailRetentionDays: 30,
    ...overrides,
  });
}

/** Writes bytes to the configured store, as a held mail item's (or, with a receipt id, that receipt's) file; returns its key. */
export async function storeFile(bytes: Uint8Array, receiptId?: string): Promise<string> {
  const key = receiptId ? receiptFileKey(receiptId) : newMailItemFileKey();
  await fileStore().put(key, bytes, sha256Hex(bytes));
  return key;
}

/** The bytes the configured store holds under a row's key. */
export async function storedBytes(fileKey: string | null): Promise<string> {
  const bytes = fileKey ? await fileStore().get(fileKey) : null;
  return Buffer.from(bytes ?? []).toString();
}

export async function clearAll(): Promise<void> {
  // A reading the last test left running would write audit rows after they are cleared.
  await settleReads();
  testStore.objects.clear();
  await db.receiptAuditLog.deleteMany();
  await db.receiptPairDecision.deleteMany();
  await db.receiptLineItem.deleteMany();
  await db.receiptDetail.deleteMany();
  await db.receipt.deleteMany();
  await db.receiptOrgSettings.deleteMany();
  await db.receiptMailItem.deleteMany();
  await db.receiptIgnoredFile.deleteMany();
  await db.receiptMailReply.deleteMany();
  await db.receiptMailAtRisk.deleteMany();
  await db.receiptMailMessage.deleteMany();
  await db.receiptMailLease.deleteMany();
  await db.receiptOutcomeNotice.deleteMany();
}

let seq = 0;
/** A distinct, valid text receipt file. */
export function textFile(label = `receipt ${++seq} ${Date.now()}`): Buffer {
  return Buffer.from(`ACME HARDWARE\n${label}\n`);
}

export function manualDetails(over: Record<string, unknown> = {}) {
  return {
    retailer: "Acme Hardware",
    receiptDate: new Date().toISOString().slice(0, 10),
    receiptTotal: "20.00",
    lineItems: [{ description: "Bolt", quantity: 2, unitPrice: 10 }],
    ...over,
  };
}

/** A reader that always fails with this kind. */
export const failingOcr = (kind: FailureKind, error = "test failure"): OcrProvider => ({
  extract: async () => ({ success: false, kind, error }),
});

export const okOcr = (over: Record<string, unknown> = {}): OcrProvider => ({
  extract: async () => ({
    success: true,
    data: Object.assign({
      retailer: "OCR Hardware",
      receiptDate: new Date().toISOString().slice(0, 10),
      currency: "USD",
      shipping: 0,
      tax: 0,
      discount: 0,
      receiptTotal: 5,
      lineItems: [{ description: "Nut", quantity: 1, unitPrice: 5, isDelayed: false }],
    }, over),
  }),
});

export async function stateOf(id: string): Promise<string | undefined> {
  return (await db.receiptDetail.findUnique({ where: { id } }))?.state;
}

export async function actions(id: string): Promise<string[]> {
  return (await db.receiptAuditLog.findMany({ where: { receiptId: id }, orderBy: { id: "asc" } })).map((a) => a.action);
}

/** Waits for every background reading started so far, and those they start in turn. */
export async function settleReads(): Promise<void> {
  while (readsInFlight.size > 0) await Promise.all([...readsInFlight]);
}

/** Uploads, waits for its background reading to land, and answers the uploader's view of the receipt then. */
export async function uploadRead(...args: Parameters<typeof receiptService.upload>) {
  const r = await receiptService.upload(...args);
  await settleReads();
  const { lineItems: _lines, financialReviewReasons: _reasons, purchaseOutcome: _outcome, duplicateNotice: _notice, ...view } = await receiptService.get(r.id, "submitter");
  return view;
}

/** "Read it again", waits for that reading to land, and answers the receipt as it then stands. */
export async function retryRead(...args: Parameters<typeof receiptService.retryOcr>) {
  const [id, access] = args;
  await receiptService.retryOcr(...args);
  await settleReads();
  return receiptService.get(id, access);
}
