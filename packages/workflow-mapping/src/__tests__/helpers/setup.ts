import type { CompletedReceipt, ResolvedInventoryDelta } from "@inventory/receipt-types";
import { db } from "../../db";
import type { ReceivedReceiptLineStatus, ReceivedReceiptState } from "../../db/schema";
import type { WorkflowPrincipal, WorkflowRuntimeConfig } from "../../contract";
import { configureWorkflowMapping } from "../../runtime";

export const TEST_ORG_ID = "00000000-0000-0000-0000-000000000001";
export const OTHER_ORG_ID = "00000000-0000-0000-0000-000000000099";
export const TEST_ORG_NAME = "Test Org";
export const MANAGER: WorkflowPrincipal = { id: 7, name: "manager" };

export class TestHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Records what reaches each push target; succeeds unless told to fail. */
export function recordingSinks() {
  const calls = {
    expense: [] as CompletedReceipt[],
    donation: [] as CompletedReceipt[],
    inventory: [] as ResolvedInventoryDelta[],
  };
  const fail = { expense: false, donation: false, inventory: false };
  return {
    calls,
    fail,
    expenseSink: {
      pushReceipt: async (r: CompletedReceipt) => {
        calls.expense.push(r);
        if (fail.expense) throw new Error("expense down");
      },
    },
    donationSink: {
      ingestInKind: async (r: CompletedReceipt) => {
        calls.donation.push(r);
        if (fail.donation) throw new Error("donations down");
      },
    },
    inventorySink: {
      applyDelta: async (d: ResolvedInventoryDelta) => {
        calls.inventory.push(d);
        if (fail.inventory) throw new Error("inventory down");
      },
    },
  };
}

/** Configure the runtime with a manager principal and the given port overrides (inert otherwise). */
export function configure(
  overrides: Partial<WorkflowRuntimeConfig> & { principal?: WorkflowPrincipal | null } = {},
): void {
  const { principal = MANAGER, ...rest } = overrides;
  configureWorkflowMapping({
    auth: { getPrincipal: async () => principal },
    org: async () => ({ id: TEST_ORG_ID, name: TEST_ORG_NAME }),
    httpError: (status, message) => new TestHttpError(status, message),
    ...rest,
  });
}

export async function clearAll(): Promise<void> {
  await db.workflowAuditLog.deleteMany({});
  await db.receivedReceiptLineStatus.deleteMany({});
  await db.receivedReceipt.deleteMany({});
  await db.workflowSystemData.deleteMany({});
}

let seq = 0;
export function uid(): string {
  return `test-${Date.now()}-${++seq}`;
}

function buildLineItem(receiptLineItemId: number) {
  return {
    receiptLineItemId,
    lineNumber: receiptLineItemId,
    description: `Widget ${receiptLineItemId}`,
    partNumber: `PN-${receiptLineItemId}`,
    manufacturer: "Acme",
    quantity: 1,
    unitPriceCents: 10,
    totalPriceCents: 10,
    isDelayed: false,
  };
}

export function buildReceiptPayload(
  opts: { orgId?: string; receiptId?: string; lineCount?: number; isInKind?: boolean } = {},
): CompletedReceipt {
  const lineCount = opts.lineCount ?? 1;
  return {
    receiptId: opts.receiptId ?? uid(),
    orgId: opts.orgId ?? TEST_ORG_ID,
    submitterId: 4242,
    vendorName: "Acme Hardware",
    receiptNumber: "R-1",
    orderNumber: null,
    currency: "USD",
    taxCents: 0,
    shippingCents: 0,
    discountCents: 0,
    receiptTotalCents: 10 * lineCount,
    receiptDate: "2026-01-15",
    needsReimbursement: true,
    reimbursementFor: "Jane Doe",
    submittedAt: new Date().toISOString(),
    backfill: false,
    isInKind: opts.isInKind ?? false,
    lineItems: Array.from({ length: lineCount }, (_, i) => buildLineItem(i + 1)),
  };
}

export async function makeReceipt(
  opts: { orgId?: string; state?: ReceivedReceiptState; lineCount?: number; isInKind?: boolean } = {},
) {
  const orgId = opts.orgId ?? TEST_ORG_ID;
  return db.receivedReceipt.create({
    data: {
      orgId,
      receiptId: uid(),
      state: opts.state ?? "pending_review",
      receiptJson: JSON.stringify(buildReceiptPayload({ orgId, lineCount: opts.lineCount, isInKind: opts.isInKind })),
    },
  });
}

export async function makeLineStatus(
  receivedReceiptId: number,
  opts: {
    receiptLineItemId?: number;
    recognitionStatus?: ReceivedReceiptLineStatus;
    assignedGtin13?: string | null;
    provisionalItemGtin13?: string | null;
  } = {},
) {
  return db.receivedReceiptLineStatus.create({
    data: {
      receivedReceiptId,
      receiptLineItemId: opts.receiptLineItemId ?? 1,
      recognitionStatus: opts.recognitionStatus ?? "recognized",
      assignedGtin13: opts.assignedGtin13 ?? null,
      provisionalItemGtin13: opts.provisionalItemGtin13 ?? null,
    },
  });
}
