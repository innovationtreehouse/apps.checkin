import { parse } from "csv-parse/sync";
import { ShopifyPayoutRowSchema, type ShopifyPayoutRow } from "./schemas";
import { toCents } from "./money";

// Money columns are parsed into integer cents at this trust boundary; see money.ts.
const parseNum = toCents;

export function parseShopifyPayoutCsv(buffer: Buffer): ShopifyPayoutRow[] {
  const records = parse(buffer, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  }) as Record<string, string>[];

  return records.map((r) => {
    const row = {
      payoutDate: r["Payout Date"] ?? "",
      status: r["Status"] ?? "",
      chargesCents: parseNum(r["Charges"]),
      refundsCents: parseNum(r["Refunds"]),
      adjustmentsCents: parseNum(r["Adjustments"]),
      marketplaceSalesTaxCents: parseNum(r["Marketplace Sales Tax"]),
      advancesCents: parseNum(r["Advances"]),
      reservedFundsCents: parseNum(r["Reserved Funds"]),
      feesCents: parseNum(r["Fees"]),
      retriedAmountCents: parseNum(r["Retried Amount"]),
      totalCents: parseNum(r["Total"]),
      currency: r["Currency"] ?? "USD",
      bankReference: r["Bank Reference"]?.trim() || null,
    };
    return ShopifyPayoutRowSchema.parse(row);
  });
}
