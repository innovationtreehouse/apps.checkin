/**
 * Project normalized payouts and balance transactions into the live tables.
 * Idempotent upserts keyed on Shopify GID. Balance-transaction cents are signed,
 * so a payout containing refunds/adjustments yields negative rows whose nets sum
 * back to the payout net — no special casing.
 */
import type { DbClient } from "../ingest/rawLog.js";
import type { EventSource } from "../generated/prisma/client.js";
import type { NormalizedPayout, NormalizedBalanceTxn } from "../shopify/schemas.js";

export async function projectPayout(
  db: DbClient,
  storeId: string,
  payout: NormalizedPayout,
  source: EventSource,
): Promise<void> {
  const fields = {
    storeId,
    legacyId: payout.legacyId ?? null,
    issuedAt: payout.issuedAt,
    status: payout.status ?? null,
    currency: payout.currency ?? null,
    netCents: payout.netCents,
    chargesGrossCents: payout.chargesGrossCents,
    chargesFeeCents: payout.chargesFeeCents,
    refundsGrossCents: payout.refundsGrossCents,
    refundsFeeCents: payout.refundsFeeCents,
    adjustmentsGrossCents: payout.adjustmentsGrossCents,
    adjustmentsFeeCents: payout.adjustmentsFeeCents,
    reservedFundsCents: payout.reservedFundsCents,
    retriedCents: payout.retriedCents,
    source,
    lastSyncedAt: new Date(),
  };
  await db.shopPayout.upsert({
    where: { storeId_payoutGid: { storeId, payoutGid: payout.payoutGid } },
    create: { payoutGid: payout.payoutGid, ...fields },
    update: fields,
  });
}

export async function projectBalanceTxn(
  db: DbClient,
  storeId: string,
  txn: NormalizedBalanceTxn,
  source: EventSource,
): Promise<void> {
  const fields = {
    storeId,
    payoutGid: txn.payoutGid ?? null,
    orderGid: txn.orderGid ?? null,
    type: txn.type,
    amountCents: txn.amountCents,
    feeCents: txn.feeCents,
    netCents: txn.netCents,
    currency: txn.currency ?? null,
    transactionDate: txn.transactionDate,
    sourceOrderTransactionId: txn.sourceOrderTransactionId ?? null,
    source,
  };
  await db.shopBalanceTransaction.upsert({
    where: { storeId_txnGid: { storeId, txnGid: txn.txnGid } },
    create: { txnGid: txn.txnGid, ...fields },
    update: fields,
  });
}
