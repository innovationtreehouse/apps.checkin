import type { TxClient } from "./audit";
import type { ShopifyPayoutRow } from "./schemas";

export async function createPayoutFromRow(
  tx: TxClient,
  orgId: string,
  row: ShopifyPayoutRow,
  payloadJson: string,
): Promise<number> {
  const importRow = await tx.payoutImport.create({
    data: {
      orgId,
      payoutDate: row.payoutDate,
      totalCents: row.totalCents,
      payload: payloadJson,
    },
  });

  await tx.payout.create({
    data: {
      id: importRow.id,
      orgId,
      payoutDate: row.payoutDate,
      status: row.status,
      chargesCents: row.chargesCents,
      refundsCents: row.refundsCents,
      adjustmentsCents: row.adjustmentsCents,
      marketplaceSalesTaxCents: row.marketplaceSalesTaxCents,
      advancesCents: row.advancesCents,
      reservedFundsCents: row.reservedFundsCents,
      feesCents: row.feesCents,
      retriedAmountCents: row.retriedAmountCents,
      totalCents: row.totalCents,
      currency: row.currency,
      bankReference: row.bankReference,
    },
  });

  return importRow.id;
}
