// In-kind donations that arrived with a receipt (FR5, design #1280 §2.4). The money side (X9)
// and the donor (X13) land on one row per (orgId, receiptId), in either order. The money side is
// written once: a replay with the same values does nothing, and one that differs is kept out and
// raised for finance.
import { db } from "../db";
import type { InKindDonor } from "../contract";
import { recordEvent } from "../repositories/audit";
import type { AuditContext } from "../workflows/disbursement.actor";
import { ServiceError } from "@checkin/component-kit";

export interface InKindMoneyLine {
  receiptLineItemId: number;
  lineNumber: number;
  description: string;
  gtin13: string | null;
  quantity: number;
  valueCents: number;
}

export interface InKindMoney {
  receiptTotalCents: number;
  receiptDate: string | null;
  uploadedByUserId: number;
  lines: InKindMoneyLine[];
}

const lineKey = (l: Pick<InKindMoneyLine, "receiptLineItemId" | "quantity" | "valueCents">) => `${l.receiptLineItemId}:${l.quantity}:${l.valueCents}`;

function sameMoney(
  stored: { receiptTotalCents: number | null; receiptDate: string | null; lines: InKindMoneyLine[] },
  money: InKindMoney,
): boolean {
  if (stored.receiptTotalCents !== money.receiptTotalCents || stored.receiptDate !== money.receiptDate) return false;
  const a = stored.lines.map(lineKey).sort();
  const b = money.lines.map(lineKey).sort();
  return a.length === b.length && a.every((k, i) => k === b[i]);
}

/** X9: record the money side once. The row lock serialises concurrent arrivals for one receipt. */
async function recordMoney(orgId: string, receiptId: string, money: InKindMoney): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`INSERT INTO in_kind_donations (org_id, receipt_id) VALUES (${orgId}, ${receiptId}) ON CONFLICT (org_id, receipt_id) DO NOTHING`;
    const [{ id }] = await tx.$queryRaw<{ id: number }[]>`SELECT id FROM in_kind_donations WHERE org_id = ${orgId} AND receipt_id = ${receiptId} FOR UPDATE`;
    const row = await tx.inKindDonation.findUniqueOrThrow({ where: { id }, include: { lines: true } });

    if (row.moneyReceivedAt === null) {
      await tx.inKindDonation.update({
        where: { id },
        data: {
          receiptTotalCents: money.receiptTotalCents,
          receiptDate: money.receiptDate,
          uploadedByUserId: money.uploadedByUserId,
          moneyReceivedAt: new Date(),
          lines: { create: money.lines },
        },
      });
      await recordEvent(tx, { orgId, entityType: "in_kind", entityId: receiptId, eventType: "IN_KIND_MONEY_RECEIVED" });
      return;
    }
    // A row with no lines takes its lines and uploader from a replay with the same total and date.
    const legacy = row.lines.length === 0 && row.receiptTotalCents === money.receiptTotalCents && row.receiptDate === money.receiptDate;
    if (legacy || sameMoney(row, money)) {
      if (legacy || row.uploadedByUserId === null) {
        await tx.inKindDonation.update({
          where: { id },
          data: { uploadedByUserId: row.uploadedByUserId ?? money.uploadedByUserId, ...(legacy ? { lines: { create: money.lines } } : {}) },
        });
      }
      return;
    }
    if (row.replayConflictAt === null) {
      await tx.inKindDonation.update({ where: { id }, data: { replayConflictAt: new Date() } });
    }
    await recordEvent(tx, {
      orgId,
      entityType: "in_kind",
      entityId: receiptId,
      eventType: "IN_KIND_REPLAY_CONFLICT",
      payload: { storedTotalCents: row.receiptTotalCents, replayTotalCents: money.receiptTotalCents },
    });
  });
}

/**
 * X13: record the donor; a later call replaces it, and a replacement that differs stamps
 * donorReplacedAt for the accept screen. The audit row carries no donor field.
 */
async function recordDonor(orgId: string, receiptId: string, donor: InKindDonor): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`
      INSERT INTO in_kind_donations (org_id, receipt_id, donor_first_name, donor_last_name, donor_company_name, donor_recorded_at)
      VALUES (${orgId}, ${receiptId}, ${donor.firstName}, ${donor.lastName}, ${donor.companyName}, now())
      ON CONFLICT (org_id, receipt_id) DO UPDATE SET
        donor_replaced_at = CASE
          WHEN in_kind_donations.donor_recorded_at IS NOT NULL AND (
            in_kind_donations.donor_first_name IS DISTINCT FROM EXCLUDED.donor_first_name OR
            in_kind_donations.donor_last_name IS DISTINCT FROM EXCLUDED.donor_last_name OR
            in_kind_donations.donor_company_name IS DISTINCT FROM EXCLUDED.donor_company_name)
          THEN now() ELSE in_kind_donations.donor_replaced_at END,
        donor_first_name = EXCLUDED.donor_first_name,
        donor_last_name = EXCLUDED.donor_last_name,
        donor_company_name = EXCLUDED.donor_company_name,
        donor_recorded_at = EXCLUDED.donor_recorded_at`;
    await recordEvent(tx, { orgId, entityType: "in_kind", entityId: receiptId, eventType: "IN_KIND_DONOR_RECORDED" });
  });
}

/**
 * X13: the in-kind mark was cleared. Without a money side the row (and its donor pii) is
 * deleted; with one, nothing is deleted and the receipt is flagged as an anomaly for finance.
 * An unknown receipt is a no-op.
 */
async function withdraw(orgId: string, receiptId: string): Promise<void> {
  await db.$transaction(async (tx) => {
    const deleted = await tx.inKindDonation.deleteMany({ where: { orgId, receiptId, moneyReceivedAt: null } });
    if (deleted.count > 0) {
      await recordEvent(tx, { orgId, entityType: "in_kind", entityId: receiptId, eventType: "IN_KIND_WITHDRAWN" });
      return;
    }
    const flagged = await tx.inKindDonation.updateMany({
      where: { orgId, receiptId, withdrawnAfterMoneyAt: null },
      data: { withdrawnAfterMoneyAt: new Date() },
    });
    if (flagged.count > 0) {
      await recordEvent(tx, { orgId, entityType: "in_kind", entityId: receiptId, eventType: "IN_KIND_WITHDRAWN_AFTER_MONEY" });
    }
  });
}

export type SettleKind = "withdrawal" | "replay";

/**
 * Finance settles a receipt gift's anomaly. Settling a withdrawal records that finance reversed
 * any booked side by hand and clears the donor; the gift and its money stay. Settling a replay
 * conflict keeps the first values. Nothing here touches QuickBooks.
 */
async function settle(orgId: string, id: number, kind: SettleKind, audit: AuditContext & { actorUserId: number }) {
  return db.$transaction(async (tx) => {
    const gift = await tx.inKindDonation.findFirst({ where: { id, orgId }, select: { receiptId: true } });
    if (!gift) throw new ServiceError(404, "In-kind gift not found");
    const settledAt = new Date();
    const updated =
      kind === "withdrawal"
        ? await tx.inKindDonation.updateMany({
            where: { id, withdrawnAfterMoneyAt: { not: null }, withdrawalSettledAt: null },
            data: { withdrawalSettledAt: settledAt, donorFirstName: null, donorLastName: null, donorCompanyName: null },
          })
        : await tx.inKindDonation.updateMany({ where: { id, replayConflictAt: { not: null } }, data: { replayConflictAt: null } });
    if (updated.count === 0) {
      throw new ServiceError(409, kind === "withdrawal" ? "This gift has no open withdrawal to settle" : "This gift has no replay conflict to settle");
    }
    const bookedSides = await tx.inKindBooking.findMany({ where: { orgId, source: "receipt", giftId: id }, select: { side: true, matchState: true } });
    await recordEvent(tx, {
      orgId,
      entityType: "in_kind",
      entityId: gift.receiptId,
      eventType: kind === "withdrawal" ? "IN_KIND_WITHDRAWAL_SETTLED" : "IN_KIND_REPLAY_SETTLED",
      ...audit,
      payload: { bookedSides },
    });
    return { id, kind, settledAt };
  });
}

export const inKindService = { recordMoney, recordDonor, withdraw, settle };
