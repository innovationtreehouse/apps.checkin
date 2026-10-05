import { parse } from "csv-parse/sync";
import { ShopifyPayoutDetailRowSchema, type ShopifyPayoutDetailRow } from "./shopify-payout-detail-schemas";
import { toCents } from "./money";

// Money parsed into integer cents at this boundary; see money.ts.
const parseNum = toCents;

export function parseShopifyPayoutDetailCsv(buffer: Buffer): Map<string, ShopifyPayoutDetailRow[]> {
  const records = parse(buffer, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  }) as Record<string, string>[];

  const result = new Map<string, ShopifyPayoutDetailRow[]>();

  for (const r of records) {
    const shopifyPayoutId = r["Payout ID"]?.trim() ?? "";
    if (!shopifyPayoutId) continue;

    const rawType = r["Type"]?.trim().toLowerCase();
    const transactionType = rawType === "refund" ? "refund" : "charge";

    const row = ShopifyPayoutDetailRowSchema.parse({
      transactionDate: r["Transaction Date"] ?? "",
      transactionType,
      orderRef: r["Order"]?.trim() || null,
      payoutStatus: r["Payout Status"] ?? "",
      payoutDate: r["Payout Date"] ?? "",
      shopifyPayoutId,
      amount: parseNum(r["Amount"]),
      fee: parseNum(r["Fee"]),
      net: parseNum(r["Net"]),
      currency: r["Currency"] ?? "USD",
    });

    const existing = result.get(shopifyPayoutId);
    if (existing) {
      existing.push(row);
    } else {
      result.set(shopifyPayoutId, [row]);
    }
  }

  return result;
}
