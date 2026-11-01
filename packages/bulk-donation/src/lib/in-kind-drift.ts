// Drift detection: re-reads the QuickBooks entries in-kind gifts hold and hands a gift to finance
// when an entry was removed, voided or edited after booking. QuickBooks is only read.
import { dollarsToCents } from "@checkin/money";
import { MAX_DRIFT_CHECKS_PER_RUN, appKeyOf, todaysSlice, type QuickBooksClient } from "@checkin/quickbooks";
import { db } from "../db";
import { recordEvent } from "../repositories/audit";
import { inKindKey, lockPosting } from "./in-kind-poster";
import { QB_MATCH_STATE } from "./qb-match";

const SYSTEM = { actorUserId: null, actorUsername: "system:qb-drift", correlationId: null };

export type InKindDriftCounts = { checked: number; drifted: number } | { failed: true };

interface ReadEntry {
  Id: string;
  TxnDate: string;
  TotalAmt: number;
  PrivateNote?: string;
}

/**
 * The cron's drift step over CREATED and MATCHED gifts, by-id reads only, capped per run. A voided
 * entry reads as an amount of zero. A failed read says nothing about any entry, so it moves no gift.
 */
export async function checkInKindQbDrift(orgId: string, client: QuickBooksClient, now = new Date()): Promise<InKindDriftCounts> {
  const [postings, receipts] = await Promise.all([
    db.inKindPosting.findMany({ where: { orgId, matchState: { in: [QB_MATCH_STATE.CREATED, QB_MATCH_STATE.MATCHED] } }, orderBy: { id: "asc" } }),
    db.inKindDonation.findMany({ where: { orgId }, select: { id: true, receiptId: true, withdrawnAfterMoneyAt: true } }),
  ]);
  const receiptOf = new Map(receipts.map((r) => [r.id, r]));
  const checkable = postings.filter((p) => p.source !== "receipt" || !receiptOf.get(p.giftId)?.withdrawnAfterMoneyAt);
  const slice = todaysSlice(checkable, MAX_DRIFT_CHECKS_PER_RUN, now);
  if (slice.length === 0) return { checked: 0, drifted: 0 };

  const bookings = await db.inKindBooking.findMany({ where: { orgId, OR: slice.map((p) => ({ source: p.source, giftId: p.giftId })) } });
  const idsOf = (entity: string) => bookings.flatMap((b) => (b.qbEntity === entity && b.qbTxnId ? [b.qbTxnId] : []));
  let reads: [ReadEntry[], ReadEntry[], ReadEntry[]];
  try {
    reads = await Promise.all([client.journalEntriesByIds(idsOf("JournalEntry")), client.depositsByIds(idsOf("Deposit")), client.purchasesByIds(idsOf("Purchase"))]);
  } catch (err) {
    console.warn("[bulk-donation] in-kind drift read failed", err);
    return { failed: true };
  }
  const entries = new Map<string, ReadEntry>();
  (["JournalEntry", "Deposit", "Purchase"] as const).forEach((entity, i) => reads[i].forEach((e) => entries.set(`${entity}:${e.Id}`, e)));

  let drifted = 0;
  for (const p of slice) {
    const changes: string[] = [];
    for (const b of bookings.filter((row) => row.source === p.source && row.giftId === p.giftId)) {
      const entry = entries.get(`${b.qbEntity}:${b.qbTxnId}`);
      const fields: string[] = [];
      // The posting's date is the journal entry's or the deposit's; only a Purchase can lack a baseline.
      const bookedDate = b.bookedTxnDate ?? (b.side === "expense" ? null : p.bookedTxnDate);
      if (!entry) fields.push("missing");
      else {
        if (p.bookedTotalCents !== null && dollarsToCents(entry.TotalAmt) !== p.bookedTotalCents) fields.push("amount");
        if (bookedDate !== null && entry.TxnDate !== bookedDate) fields.push("date");
        if (p.matchState === QB_MATCH_STATE.CREATED && appKeyOf(entry) !== inKindKey(orgId, p.source, p.giftId)) fields.push("key");
        if (bookedDate === null) await db.inKindBooking.update({ where: { id: b.id }, data: { bookedTxnDate: entry.TxnDate } });
      }
      if (fields.length > 0) changes.push(`${b.qbEntity} ${b.qbTxnId} ${fields.join(", ")}`);
    }
    if (changes.length === 0) continue;
    const moved = await db.$transaction(async (tx) => {
      const current = await lockPosting(tx, orgId, p.source, p.giftId);
      // Anything that touched the posting since the read may have changed what it holds; the next run looks again.
      if (current?.updatedAt.getTime() !== p.updatedAt.getTime()) return false;
      await tx.inKindBooking.updateMany({ where: { orgId, source: p.source, giftId: p.giftId }, data: { matchState: QB_MATCH_STATE.DRIFT } });
      await tx.inKindPosting.update({
        where: { id: p.id },
        data: { matchState: QB_MATCH_STATE.DRIFT, qbNote: `Changed in QuickBooks since booking (${changes.join("; ")}): match the gift again or skip it with a reason` },
      });
      const receiptId = p.source === "receipt" ? receiptOf.get(p.giftId)?.receiptId : null;
      await recordEvent(tx, {
        orgId,
        entityType: p.source === "receipt" ? "in_kind" : "manual_in_kind",
        entityId: receiptId ?? String(p.giftId),
        eventType: "IN_KIND_QB_DRIFT",
        ...SYSTEM,
        payload: { from: p.matchState, changes },
      });
      return true;
    });
    if (moved) drifted++;
  }
  return { checked: slice.length, drifted };
}
