// Pull Purchases + Bills in a date window → normalized ground-truth JSON. Proves reads work end to end.
// Run: npm run pull -w @inventory/quickbooks -- 2024-01-01 [2024-12-31] [outfile]
// Reads in MAX_WINDOW_DAYS chunks. The production company also needs CHECKIN_ENV=prod.
import { writeFileSync } from "node:fs";
import { MAX_WINDOW_DAYS, QuickBooksClient, qboEnvFromEnv, toGroundTruth } from "../src/client";
import type { QboPurchase } from "../src/types";
import { fileAccessTokenSource, loadTokens, tokenFileFromEnv } from "../src/local";

const fromDate = process.argv[2] ?? "2024-01-01";
const toDate = process.argv[3] ?? new Date().toISOString().slice(0, 10);
const outFile = process.argv[4] ?? new URL("../.ground-truth.json", import.meta.url).pathname;

const tokenFile = tokenFileFromEnv();
const saved = loadTokens(tokenFile);
if (!saved) throw new Error(`No QBO tokens at ${tokenFile}; run \`npm run consent -w @inventory/quickbooks\` first`);
const client = new QuickBooksClient(fileAccessTokenSource(tokenFile), { env: qboEnvFromEnv(), realmId: saved.realmId });
const day = (d: Date): string => d.toISOString().slice(0, 10);
const plusDays = (d: Date, n: number): Date => new Date(d.getTime() + n * 86_400_000);
const purchases: QboPurchase[] = [];
const bills: QboPurchase[] = [];
for (let start = new Date(fromDate); day(start) <= toDate; start = plusDays(start, MAX_WINDOW_DAYS)) {
  const end = day(plusDays(start, MAX_WINDOW_DAYS - 1));
  const to = end < toDate ? end : toDate;
  purchases.push(...(await client.purchasesBetween(day(start), to)));
  bills.push(...(await client.billsBetween(day(start), to)));
}
const records = [
  ...purchases.map((p) => toGroundTruth(p, "Purchase")),
  ...bills.map((b) => toGroundTruth(b, "Bill")),
];
console.log(`Purchases: ${purchases.length}   Bills: ${bills.length}`);

writeFileSync(outFile, JSON.stringify(records, null, 2));

// Quick shape report: count, and how many totals collide (the vendor-join collision estimate).
const byTotal = new Map<number, number>();
for (const r of records) byTotal.set(r.total, (byTotal.get(r.total) ?? 0) + 1);
const collisions = [...byTotal.values()].filter((n) => n > 1).length;

console.log(`Pulled ${records.length} transactions (Purchases + Bills) ${fromDate}..${toDate} → ${outFile}`);
console.log(`Distinct vendors: ${new Set(records.map((r) => r.vendor)).size}`);
console.log(`Totals shared by >1 txn (collision groups): ${collisions}`);
