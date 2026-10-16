// In-kind donations that arrived with a receipt (FR5, design #1280 §2.4). The money side (X9)
// and the donor (X13) land on one row per (orgId, receiptId), in either order. Each write is a
// single atomic statement, so concurrent calls for one receipt never lose a half.
import { db } from "../db";
import type { InKindDonor } from "../contract";
import { recordEvent } from "../repositories/audit";

export interface InKindMoney {
  receiptTotalCents: number;
  receiptDate: string | null;
}

/** X9: record the money side. Replays keep the first arrival time. */
async function recordMoney(orgId: string, receiptId: string, money: InKindMoney): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`
      INSERT INTO in_kind_donations (org_id, receipt_id, receipt_total_cents, receipt_date, money_received_at)
      VALUES (${orgId}, ${receiptId}, ${money.receiptTotalCents}, ${money.receiptDate}, now())
      ON CONFLICT (org_id, receipt_id) DO UPDATE SET
        receipt_total_cents = EXCLUDED.receipt_total_cents,
        receipt_date = EXCLUDED.receipt_date,
        money_received_at = COALESCE(in_kind_donations.money_received_at, EXCLUDED.money_received_at)`;
    await recordEvent(tx, { orgId, entityType: "in_kind", entityId: receiptId, eventType: "IN_KIND_MONEY_RECEIVED" });
  });
}

/** X13: record the donor; a later call replaces it. The audit row carries no donor field. */
async function recordDonor(orgId: string, receiptId: string, donor: InKindDonor): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`
      INSERT INTO in_kind_donations (org_id, receipt_id, donor_first_name, donor_last_name, donor_company_name, donor_recorded_at)
      VALUES (${orgId}, ${receiptId}, ${donor.firstName}, ${donor.lastName}, ${donor.companyName}, now())
      ON CONFLICT (org_id, receipt_id) DO UPDATE SET
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

/** Finance-queue entries: money waiting on its donor, and withdrawals that arrived after money. No donor fields. */
async function listQueue(orgId: string) {
  return db.inKindDonation.findMany({
    where: {
      orgId,
      OR: [{ moneyReceivedAt: { not: null }, donorRecordedAt: null }, { withdrawnAfterMoneyAt: { not: null } }],
    },
    select: {
      id: true,
      receiptId: true,
      receiptTotalCents: true,
      receiptDate: true,
      moneyReceivedAt: true,
      donorRecordedAt: true,
      withdrawnAfterMoneyAt: true,
    },
    orderBy: { moneyReceivedAt: "asc" },
  });
}

export const inKindService = { recordMoney, recordDonor, withdraw, listQueue };
