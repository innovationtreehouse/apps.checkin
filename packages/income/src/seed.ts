import { readFileSync } from "node:fs";
import { parseShopifyPayoutCsv } from "./lib/csv-parser";
import { parseShopifyOrderCsv } from "./lib/shopify-order-csv-parser";
import { importPayouts } from "./lib/import";
import { importShopifyOrders } from "./lib/shopify-order-import";

const fixture = (name: string) => readFileSync(new URL(`../prisma/seed/${name}`, import.meta.url));

/** Dev seed: imports the bundled sample CSVs for `orgId` (the host's seeded Org). Idempotent. */
export async function seedIncomeDev(orgId: string, userId: number): Promise<void> {
  const payouts = fixture("payout-sample.csv");
  await importPayouts(orgId, parseShopifyPayoutCsv(payouts), {
    userId,
    filename: "payout-sample.csv",
    buffer: payouts,
  });
  const orders = fixture("order-sample.csv");
  await importShopifyOrders(orgId, userId, "order-sample.csv", orders, parseShopifyOrderCsv(orders));
}
