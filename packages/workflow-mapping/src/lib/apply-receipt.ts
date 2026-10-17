import {
  CompletedReceiptSchema,
  ResolvedInventoryDeltaSchema,
  type CompletedReceipt,
  type CompletedReceiptLineItem,
} from "@checkin/receipt-types";
import { db } from "../db";
import type { ReceivedReceipt } from "../db/schema";
import { ports } from "../runtime";
import { parseStoredReceipt } from "./parse-receipt";
import { insertAuditEvent } from "./audit";

export type ApplyResult =
  | { state: "resolved" }
  | { state: "apply_failed"; error: string }
  // Inventory committed but its stamp failed: the receipt stays applying (lines locked) until a retry stamps it.
  | { state: "applying"; error: string };

/** How long a push's claim holds before another caller may take it over (a crashed push). */
export const APPLY_CLAIM_TTL_MS = 5 * 60_000;

interface ResolvedGtin13 {
  gtin13: string;
  isProvisional?: boolean;
}

/** Stitch each resolved line's GTIN onto the receipt sent as its money side (S2 / X9). */
export function buildExpenseReceipt(
  receipt: CompletedReceipt,
  resolve: (lineItem: CompletedReceiptLineItem) => ResolvedGtin13 | undefined,
): CompletedReceipt {
  return {
    ...receipt,
    lineItems: receipt.lineItems.map((li) => {
      const resolved = resolve(li);
      if (!resolved) return li;
      return resolved.isProvisional
        ? { ...li, gtin13: resolved.gtin13, isProvisional: true, provisionalName: li.description }
        : { ...li, gtin13: resolved.gtin13 };
    }),
  };
}

/**
 * Canonical push-and-settle path: build apply items from persisted line
 * statuses, push the money side (expense, or donations for an in-kind receipt)
 * and the inventory delta in parallel, stamp each leg that succeeds, then
 * write the terminal state
 * (resolved / apply_failed) back to the receipt row.
 *
 * Does NOT write the intermediate "applying" state — callers are responsible
 * for that transition before invoking this function.
 *
 * Claims the receipt with a lease (`applyClaimedAt`) by conditional update, so
 * of concurrent callers only one pushes, and no transaction stays open across
 * the sinks. Returns null when another push holds a live claim or the receipt
 * is no longer `applying`. The claim is released when the push settles.
 */
export async function executePushAndSettle(
  receiptId: number,
  received: Pick<ReceivedReceipt, "id" | "orgId" | "receiptJson">,
  actorUserId?: number | null,
  actorUsername?: string | null,
): Promise<ApplyResult | null> {
  const claimedAt = new Date();
  const { count } = await db.receivedReceipt.updateMany({
    where: {
      id: receiptId,
      state: "applying",
      OR: [{ applyClaimedAt: null }, { applyClaimedAt: { lt: new Date(claimedAt.getTime() - APPLY_CLAIM_TTL_MS) } }],
    },
    data: { applyClaimedAt: claimedAt },
  });
  if (count !== 1) return null;
  try {
    return await pushAndSettle(receiptId, received, actorUserId, actorUsername);
  } finally {
    // Only our own claim: a caller that took over a stale one keeps its lease.
    await db.receivedReceipt.updateMany({
      where: { id: receiptId, applyClaimedAt: claimedAt },
      data: { applyClaimedAt: null },
    });
  }
}

async function pushAndSettle(
  receiptId: number,
  received: Pick<ReceivedReceipt, "id" | "orgId" | "receiptJson">,
  actorUserId?: number | null,
  actorUsername?: string | null,
): Promise<ApplyResult> {
  const actor = { actorUserId: actorUserId ?? null, actorUsername: actorUsername ?? null };
  await insertAuditEvent(db, {
    orgId: received.orgId,
    ...actor,
    eventType: "receipt_apply_started",
    receivedReceiptId: receiptId,
    fromState: "applying",
  });

  const parsed = parseStoredReceipt(received.receiptJson);
  if (!parsed.ok) return settleFailed(receiptId, received.orgId, actor, parsed.error);
  const receipt = parsed.receipt;

  const lineStatuses = await db.receivedReceiptLineStatus.findMany({
    where: { receivedReceiptId: receiptId },
  });
  const statusMap = new Map(lineStatuses.map((ls) => [ls.receiptLineItemId, ls]));

  const applyItems = receipt.lineItems
    .filter((li) => {
      const ls = statusMap.get(li.receiptLineItemId);
      const status = ls?.recognitionStatus ?? "unrecognized";
      if (status === "provisional") return !!ls?.provisionalItemGtin13;
      return status === "recognized" && ls?.assignedGtin13 != null;
    })
    .map((li) => {
      const ls = statusMap.get(li.receiptLineItemId)!;
      const isProvisional = ls.recognitionStatus === "provisional";
      return {
        lineItemId: li.receiptLineItemId,
        gtin13: isProvisional ? ls.provisionalItemGtin13! : ls.assignedGtin13!,
        // RAW receipt quantity — the receiving library multiplies by conversionFactor.
        quantityDelta: li.quantity,
        isDelayed: li.isDelayed,
        conversionFactor: ls.conversionFactor,
        conversionVersion: ls.conversionVersion,
        ...(isProvisional ? { isProvisional: true, provisionalName: li.description } : {}),
      };
    });

  const moneyReceipt = buildExpenseReceipt(receipt, (li) => {
    const ls = statusMap.get(li.receiptLineItemId);
    if (ls?.recognitionStatus === "provisional" && ls.provisionalItemGtin13) {
      return { gtin13: ls.provisionalItemGtin13, isProvisional: true };
    }
    if (ls?.recognitionStatus === "recognized" && ls.assignedGtin13) {
      return { gtin13: ls.assignedGtin13 };
    }
    return undefined;
  });

  const { expenseSink, donationSink, inventorySink } = ports();
  // A leg that already applied on an earlier attempt is not pushed again.
  const legs = await db.receivedReceipt.findUniqueOrThrow({
    where: { id: receiptId },
    select: { inventoryAppliedAt: true, expenseAppliedAt: true, donationAppliedAt: true },
  });
  const stamp = (data: { inventoryAppliedAt?: Date; expenseAppliedAt?: Date; donationAppliedAt?: Date }) =>
    db.receivedReceipt.update({ where: { id: receiptId }, data });

  const pushes: Array<() => Promise<void>> = [];
  let inventoryUnstamped = false;
  // An in-kind receipt's money side goes to donations, never to expense.
  if (receipt.isInKind ? !legs.donationAppliedAt : !legs.expenseAppliedAt) {
    pushes.push(async () => {
      const validated = CompletedReceiptSchema.parse(moneyReceipt);
      if (receipt.isInKind) {
        await donationSink.ingestInKind(validated);
        await stamp({ donationAppliedAt: new Date() });
      } else {
        await expenseSink.pushReceipt(validated);
        await stamp({ expenseAppliedAt: new Date() });
      }
    });
  }
  if (applyItems.length > 0 && !legs.inventoryAppliedAt) {
    pushes.push(async () => {
      await inventorySink.applyDelta(
        ResolvedInventoryDeltaSchema.parse({
          receiptId: receipt.receiptId,
          orgId: received.orgId,
          retailer: receipt.vendorName,
          lineItems: applyItems,
        }),
      );
      try {
        await stamp({ inventoryAppliedAt: new Date() });
      } catch (err) {
        inventoryUnstamped = true;
        throw err;
      }
    });
  }

  // allSettled, so every leg's applied stamp is written before the receipt settles.
  const failed = (await Promise.allSettled(pushes.map((push) => push()))).find(
    (r): r is PromiseRejectedResult => r.status === "rejected",
  );
  if (failed) {
    const err: unknown = failed.reason;
    const error = err instanceof Error ? err.message : String(err);
    // Inventory took the delta but the stamp was lost: stay applying so lines stay locked and a retry re-sends the same delta.
    if (inventoryUnstamped) return settleUnstamped(receiptId, received.orgId, actor, error);
    return settleFailed(receiptId, received.orgId, actor, error);
  }

  await db.receivedReceipt.update({
    where: { id: receiptId },
    data: { state: "resolved", validationNotes: null },
  });
  await insertAuditEvent(db, {
    orgId: received.orgId,
    ...actor,
    eventType: "receipt_apply_succeeded",
    receivedReceiptId: receiptId,
    fromState: "applying",
    toState: "resolved",
  });
  return { state: "resolved" };
}

async function settleUnstamped(
  receiptId: number,
  orgId: string,
  actor: { actorUserId: number | null; actorUsername: string | null },
  error: string,
): Promise<ApplyResult> {
  await db.receivedReceipt.update({ where: { id: receiptId }, data: { validationNotes: error } });
  await insertAuditEvent(db, {
    orgId,
    ...actor,
    eventType: "receipt_apply_failed",
    receivedReceiptId: receiptId,
    fromState: "applying",
    toState: "applying",
    details: JSON.stringify({ error, inventoryUnstamped: true }),
  });
  return { state: "applying", error };
}

async function settleFailed(
  receiptId: number,
  orgId: string,
  actor: { actorUserId: number | null; actorUsername: string | null },
  error: string,
): Promise<ApplyResult> {
  await db.receivedReceipt.update({
    where: { id: receiptId },
    data: { state: "apply_failed", validationNotes: error },
  });
  await insertAuditEvent(db, {
    orgId,
    ...actor,
    eventType: "receipt_apply_failed",
    receivedReceiptId: receiptId,
    fromState: "applying",
    toState: "apply_failed",
    details: JSON.stringify({ error }),
  });
  return { state: "apply_failed", error };
}
