import {
  CompletedReceiptSchema,
  ResolvedInventoryDeltaSchema,
  type CompletedReceipt,
  type CompletedReceiptLineItem,
} from "@checkin/receipt-types";
import { db } from "../db";
import type { ReceivedReceipt, ReceivedReceiptLineStatusRow } from "../db/schema";
import { getOrgId, ports } from "../runtime";
import { parseStoredReceipt } from "./parse-receipt";
import { insertAuditEvent } from "./audit";

export type ApplyResult =
  | { state: "resolved" }
  | { state: "apply_failed"; error: string }
  // A leg committed but its stamp failed: the receipt stays applying (lines locked) until a retry stamps it.
  | { state: "applying"; error: string };

/** How long a push's claim holds before another caller may take it over (a crashed push). */
export const APPLY_CLAIM_TTL_MS = 5 * 60_000;

export type LineResolution = { gtin13: string; isProvisional?: boolean; provisionalName?: string | null } | { nonInventory: true };

type LineStatusFields = Pick<ReceivedReceiptLineStatusRow, "recognitionStatus" | "assignedGtin13" | "provisionalItemGtin13" | "proposedName">;

/** A provisional part's name: the proposed name, else the receipt line's description. */
function provisionalName(proposedName: string | null | undefined, li: CompletedReceiptLineItem): string {
  return proposedName ?? li.description;
}

/** What receiving decided for a line, as the money side carries it; undefined while unresolved. */
export function lineResolution(ls: LineStatusFields | undefined): LineResolution | undefined {
  if (ls?.recognitionStatus === "provisional" && ls.provisionalItemGtin13) {
    return { gtin13: ls.provisionalItemGtin13, isProvisional: true, provisionalName: ls.proposedName };
  }
  if (ls?.recognitionStatus === "recognized" && ls.assignedGtin13) return { gtin13: ls.assignedGtin13 };
  if (ls?.recognitionStatus === "non_inventory") return { nonInventory: true };
  return undefined;
}

/** Stitch each resolved line's GTIN, or its non-inventory mark, onto the receipt sent as its money side (S2 / X9). */
export function buildExpenseReceipt(
  receipt: CompletedReceipt,
  resolve: (lineItem: CompletedReceiptLineItem) => LineResolution | undefined,
): CompletedReceipt {
  return {
    ...receipt,
    lineItems: receipt.lineItems.map((li) => {
      const resolved = resolve(li);
      if (!resolved) return li;
      // A non-inventory line is no catalog part, so any GTIN the receipt arrived with is dropped.
      if ("nonInventory" in resolved) return { ...li, gtin13: null, isProvisional: undefined, provisionalName: undefined, nonInventory: true };
      return resolved.isProvisional
        ? { ...li, gtin13: resolved.gtin13, isProvisional: true, provisionalName: provisionalName(resolved.provisionalName, li) }
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
 * is no longer `applying`. The claim is released when the push settles. A push that fails or
 * throws leaves the receipt stuck with its error and first failure time, for a person's Retry.
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
  } catch (err) {
    await recordFailure(receiptId, err instanceof Error ? err.message : String(err)).catch(() => {});
    throw err;
  } finally {
    // Only our own claim: a caller that took over a stale one keeps its lease.
    await db.receivedReceipt.updateMany({
      where: { id: receiptId, applyClaimedAt: claimedAt },
      data: { applyClaimedAt: null },
    });
  }
}

/** Most stuck receipts one sweep pushes; the rest wait for the next run. */
export const STUCK_APPLY_SWEEP_CAP = 50;

const unclaimedSince = (now: number) => ({
  OR: [{ applyClaimedAt: null }, { applyClaimedAt: { lt: new Date(now - APPLY_CLAIM_TTL_MS) } }],
});

/**
 * Cron backstop for receipts a crash left `applying` with no live push and no recorded failure.
 * Pushes each unclaimed or stale-claimed one once, oldest first, up to the cap, through the same
 * lease as every other caller. A push that fails is stuck and left for a person's Retry. Returns
 * counts only.
 */
export async function sweepStuckApplying(): Promise<{
  resolved: number;
  failed: number;
  applying: number;
  skipped: number;
  errored: number;
}> {
  const rows = await db.receivedReceipt.findMany({
    where: {
      orgId: await getOrgId(),
      state: "applying",
      applyFirstFailedAt: null,
      ...unclaimedSince(Date.now()),
    },
    select: { id: true, orgId: true, receiptJson: true },
    orderBy: { id: "asc" },
    take: STUCK_APPLY_SWEEP_CAP,
  });
  const counts = { resolved: 0, failed: 0, applying: 0, skipped: 0, errored: 0 };
  for (const row of rows) {
    // One receipt's database error must not stop the rest of the sweep.
    const result = await executePushAndSettle(row.id, row).catch(() => ({ state: "errored" as const }));
    if (!result) counts.skipped++;
    else if (result.state === "apply_failed") counts.failed++;
    else counts[result.state]++;
  }
  return counts;
}

/** Records a push's latest error, and its first failure time while none is set. */
async function recordFailure(receiptId: number, error: string, data: { state?: "apply_failed"; inventoryUnconfirmedAt?: Date } = {}): Promise<void> {
  await db.receivedReceipt.update({ where: { id: receiptId }, data: { ...data, validationNotes: error } });
  await db.receivedReceipt.updateMany({ where: { id: receiptId, applyFirstFailedAt: null }, data: { applyFirstFailedAt: new Date() } });
}

/** A line the inventory leg carries. */
function isInventoryLine(ls: LineStatusFields): boolean {
  if (ls.recognitionStatus === "provisional") return !!ls.provisionalItemGtin13;
  return ls.recognitionStatus === "recognized" && ls.assignedGtin13 != null;
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
      return !!ls && isInventoryLine(ls);
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
        ...(isProvisional ? { isProvisional: true, provisionalName: provisionalName(ls.proposedName, li) } : {}),
      };
    });

  const moneyReceipt = buildExpenseReceipt(receipt, (li) => lineResolution(statusMap.get(li.receiptLineItemId)));

  const { expenseSink, donationSink, inventorySink } = ports();
  // A leg that already applied on an earlier attempt is not pushed again.
  const legs = await db.receivedReceipt.findUniqueOrThrow({
    where: { id: receiptId },
    select: { inventoryAppliedAt: true, expenseAppliedAt: true, donationAppliedAt: true },
  });
  const stamp = (data: { inventoryAppliedAt?: Date; expenseAppliedAt?: Date; donationAppliedAt?: Date }) =>
    db.receivedReceipt.update({ where: { id: receiptId }, data });

  const pushes: Array<{ leg: string; push: () => Promise<void> }> = [];
  let inventoryUnstamped = false;
  let moneyUnstamped = false;
  const stampMoney = async (data: { expenseAppliedAt?: Date; donationAppliedAt?: Date }) => {
    try {
      await stamp(data);
    } catch (err) {
      moneyUnstamped = true;
      throw err;
    }
  };
  // An in-kind receipt's money side goes to donations, never to expense.
  if (receipt.isInKind ? !legs.donationAppliedAt : !legs.expenseAppliedAt) {
    pushes.push({ leg: receipt.isInKind ? "Donation" : "Expense", push: async () => {
      const validated = CompletedReceiptSchema.parse(moneyReceipt);
      if (receipt.isInKind) {
        await donationSink.ingestInKind(validated);
        await stampMoney({ donationAppliedAt: new Date() });
      } else {
        await expenseSink.pushReceipt(validated);
        await stampMoney({ expenseAppliedAt: new Date() });
      }
    } });
  }
  if (applyItems.length > 0 && !legs.inventoryAppliedAt) {
    pushes.push({ leg: "Inventory", push: async () => {
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
    } });
  }

  // allSettled, so every leg's applied stamp is written before the receipt settles.
  const results = await Promise.allSettled(pushes.map(({ push }) => push()));
  // Each failure names its leg, so the reason says which part of the receipt didn't apply.
  const failures = results.flatMap((r, i) =>
    r.status === "rejected" ? [`${pushes[i].leg}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`] : [],
  );
  if (failures.length > 0) {
    const error = failures.join("; ");
    // A sink took its leg but the stamp was lost: stay applying so lines stay locked and a retry re-sends the same payload, which the sinks dedupe.
    if (inventoryUnstamped || moneyUnstamped) return settleUnstamped(receiptId, received.orgId, actor, error, { inventoryUnstamped, moneyUnstamped });
    return settleFailed(receiptId, received.orgId, actor, error);
  }

  await db.receivedReceipt.update({
    where: { id: receiptId },
    data: { state: "resolved", validationNotes: null, applyFirstFailedAt: null },
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
  unstamped: { inventoryUnstamped: boolean; moneyUnstamped: boolean },
): Promise<ApplyResult> {
  await recordFailure(receiptId, error, unstamped.inventoryUnstamped ? { inventoryUnconfirmedAt: new Date() } : {});
  await insertAuditEvent(db, {
    orgId,
    ...actor,
    eventType: "receipt_apply_failed",
    receivedReceiptId: receiptId,
    fromState: "applying",
    toState: "applying",
    details: JSON.stringify({ error, ...unstamped }),
  });
  return { state: "applying", error };
}

async function settleFailed(
  receiptId: number,
  orgId: string,
  actor: { actorUserId: number | null; actorUsername: string | null },
  error: string,
): Promise<ApplyResult> {
  await recordFailure(receiptId, error, { state: "apply_failed" });
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
