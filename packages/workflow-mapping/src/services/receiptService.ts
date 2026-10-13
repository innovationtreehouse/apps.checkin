import { db } from "../db";
import { receivedReceiptStateEnum, type ReceivedReceiptState } from "../db/schema";
import { executePushAndSettle, type ApplyResult } from "../lib/apply-receipt";
import { insertAuditEvent } from "../lib/audit";
import { parseStoredReceipt } from "../lib/parse-receipt";
import { getOrg, httpError, requireActor } from "../runtime";
import {
  areAllLinesResolved,
  assertWorkflowMappingTransition,
  isWorkflowMappingTransitionLegal,
} from "../workflows/workflow-mapping.machine";
import { loadReceipt } from "./receiptLookup";

function asState(raw: string): ReceivedReceiptState {
  const state = receivedReceiptStateEnum.find((s) => s === raw);
  if (!state) throw httpError(400, "Invalid state");
  return state;
}

export const receiptService = {
  /** Queue rows, newest first; `states` filters (e.g. APPLY_FAILED_QUEUE_STATES). */
  async list(states?: string[]) {
    await requireActor();
    const filter = states?.map(asState);
    const rows = await db.receivedReceipt.findMany({
      where: { orgId: getOrg().id, ...(filter ? { state: { in: filter } } : {}) },
      orderBy: { createdAt: "desc" },
    });

    return rows.map((row) => {
      const parsed = parseStoredReceipt(row.receiptJson);
      const r = parsed.ok ? parsed.receipt : null;
      return {
        id: row.id,
        orgId: row.orgId,
        receiptId: row.receiptId,
        state: row.state,
        vendorName: r?.vendorName ?? null,
        receiptTotalCents: r?.receiptTotalCents ?? null,
        currency: r?.currency ?? "USD",
        lineItemCount: r?.lineItems.length ?? 0,
        validationNotes: row.validationNotes,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    });
  },

  /** Badge counts for the mapping queue and the apply-failed queue. */
  async counts(): Promise<Record<"pending_review" | "apply_failed" | "applying", number>> {
    await requireActor();
    const rows = await db.receivedReceipt.groupBy({
      by: ["state"],
      _count: { _all: true },
      where: { orgId: getOrg().id, state: { in: ["pending_review", "apply_failed", "applying"] } },
    });
    const counts = { pending_review: 0, apply_failed: 0, applying: 0 };
    for (const row of rows) {
      if (row.state === "pending_review" || row.state === "apply_failed" || row.state === "applying") {
        counts[row.state] = row._count._all;
      }
    }
    return counts;
  },

  /** One receipt with its lines. Never returns the stored receipt blob or submitter/reimbursement fields. */
  async detail(receiptId: number) {
    await requireActor();
    const { receiptJson, ...receipt } = await loadReceipt(receiptId);
    const parsed = parseStoredReceipt(receiptJson);
    if (!parsed.ok) throw httpError(422, parsed.error);
    const p = parsed.receipt;
    const lineStatuses = await db.receivedReceiptLineStatus.findMany({
      where: { receivedReceiptId: receiptId },
      orderBy: { receiptLineItemId: "asc" },
    });

    // Money stays integer cents; the client formats once at render.
    const parsedReceipt = {
      receiptId: p.receiptId,
      orgId: p.orgId,
      vendorName: p.vendorName,
      currency: p.currency,
      receiptTotalCents: p.receiptTotalCents,
      taxCents: p.taxCents,
      shippingCents: p.shippingCents,
      discountCents: p.discountCents,
      receiptDate: p.receiptDate,
      isInKind: p.isInKind,
      lineItems: p.lineItems.map((li) => ({
        receiptLineItemId: li.receiptLineItemId,
        lineNumber: li.lineNumber,
        description: li.description,
        partNumber: li.partNumber,
        manufacturer: li.manufacturer,
        quantity: li.quantity,
        unitPriceCents: li.unitPriceCents,
        totalPriceCents: li.totalPriceCents,
        isDelayed: li.isDelayed,
      })),
    };

    return { receipt, parsedReceipt, lineStatuses };
  },

  async proceed(receiptId: number): Promise<{ state: ReceivedReceiptState }> {
    const actor = await requireActor();
    const received = await loadReceipt(receiptId);

    if (!isWorkflowMappingTransitionLegal(received.state as ReceivedReceiptState, "PROCEED")) {
      throw httpError(409, `Cannot proceed receipt in state "${received.state}"`);
    }

    const lineStatuses = await db.receivedReceiptLineStatus.findMany({ where: { receivedReceiptId: receiptId } });
    if (!areAllLinesResolved(lineStatuses)) {
      const unresolved = lineStatuses.filter((ls) => ls.recognitionStatus === "unrecognized").length;
      throw httpError(400, `${unresolved} line item(s) still unrecognized`);
    }

    const nextState = assertWorkflowMappingTransition(received.state as ReceivedReceiptState, "PROCEED");

    // Compare-and-set: a concurrent proceed (manual or auto) that already moved it wins.
    const { count } = await db.receivedReceipt.updateMany({
      where: { id: receiptId, state: received.state },
      data: { state: nextState },
    });
    if (count !== 1) throw httpError(409, "Receipt was already proceeded");

    await insertAuditEvent(db, {
      orgId: received.orgId,
      actorUserId: actor.id,
      actorUsername: actor.name,
      eventType: "receipt_proceeded",
      receivedReceiptId: receiptId,
      fromState: received.state,
      toState: nextState,
    });

    return { state: nextState };
  },

  /** Push an `applying` receipt and settle it. */
  async apply(receiptId: number): Promise<ApplyResult> {
    const actor = await requireActor();
    const received = await loadReceipt(receiptId);

    if (!isWorkflowMappingTransitionLegal(received.state as ReceivedReceiptState, "PUSH_SUCCEEDED")) {
      throw httpError(409, `Cannot apply receipt in state "${received.state}"`);
    }
    const parsed = parseStoredReceipt(received.receiptJson);
    if (!parsed.ok) throw httpError(422, parsed.error);

    return executePushAndSettle(receiptId, received, actor.id, actor.name);
  },

  async retryApply(receiptId: number): Promise<{ state: ReceivedReceiptState }> {
    const actor = await requireActor();
    const received = await loadReceipt(receiptId);

    if (!isWorkflowMappingTransitionLegal(received.state as ReceivedReceiptState, "RETRY")) {
      throw httpError(409, `Cannot retry receipt in state "${received.state}"`);
    }
    const nextState = assertWorkflowMappingTransition(received.state as ReceivedReceiptState, "RETRY");

    await insertAuditEvent(db, {
      orgId: received.orgId,
      actorUserId: actor.id,
      actorUsername: actor.name,
      eventType: "receipt_retry_started",
      receivedReceiptId: receiptId,
      fromState: received.state,
      toState: nextState,
    });

    await db.receivedReceipt.update({ where: { id: receiptId }, data: { state: nextState } });

    return { state: nextState };
  },

  async auditLog(opts: { receiptId?: number | null; limit?: number | null; before?: Date | null } = {}) {
    await requireActor();
    const limit = Math.min(Math.max(1, opts.limit ?? 100), 500);
    const before = opts.before && !Number.isNaN(opts.before.getTime()) ? opts.before : null;
    const rows = await db.workflowAuditLog.findMany({
      where: {
        orgId: getOrg().id,
        ...(opts.receiptId ? { receivedReceiptId: opts.receiptId } : {}),
        ...(before ? { createdAt: { lt: before } } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
    });

    return rows.map((row) => ({
      id: row.id,
      actorUserId: row.actorUserId,
      actorUsername: row.actorUsername,
      eventType: row.eventType,
      receivedReceiptId: row.receivedReceiptId,
      lineStatusId: row.lineStatusId,
      fromState: row.fromState,
      toState: row.toState,
      details: row.details ? (JSON.parse(row.details) as unknown) : null,
      createdAt: row.createdAt.toISOString(),
    }));
  },
};
