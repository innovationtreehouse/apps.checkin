import type { CompletedReceipt } from "@inventory/receipt-types";
import { db } from "../../db";
import type { InKindDonor, OcrProvider, ReceiptConfig, ReceiptPrincipal } from "../../contract";
import { configureReceipt } from "../../runtime";

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

/** Records what reaches each port; succeeds unless told to fail. */
export function recordingPorts() {
  const calls = {
    pushes: [] as CompletedReceipt[],
    donors: [] as Array<{ orgId: string; receiptId: string; donor: InKindDonor }>,
    withdrawals: [] as Array<{ orgId: string; receiptId: string }>,
  };
  const fail = { push: false, donor: false };
  return {
    calls,
    fail,
    receiptSink: {
      ingestReceipt: async (r: CompletedReceipt) => {
        calls.pushes.push(r);
        if (fail.push) throw new Error("workflow-mapping down");
        return { id: calls.pushes.length, state: "pending_review", created: true };
      },
    },
    donorSink: {
      recordInKindDonor: async (orgId: string, receiptId: string, donor: InKindDonor) => {
        calls.donors.push({ orgId, receiptId, donor });
        if (fail.donor) throw new Error("donations down");
      },
      withdrawInKind: async (orgId: string, receiptId: string) => {
        calls.withdrawals.push({ orgId, receiptId });
        if (fail.donor) throw new Error("donations down");
      },
    },
  };
}

export function configure(overrides: Partial<ReceiptConfig> = {}): void {
  current = ALICE;
  configureReceipt({
    auth: { getPrincipal: async () => current },
    org: async () => ({ id: TEST_ORG_ID, name: "Test Org" }),
    ...overrides,
  });
}

export async function clearAll(): Promise<void> {
  await db.receiptAuditLog.deleteMany();
  await db.receiptLineItem.deleteMany();
  await db.receiptDetail.deleteMany();
  await db.receipt.deleteMany();
  await db.receiptOrgSettings.deleteMany();
  await db.receiptMailItem.deleteMany();
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
