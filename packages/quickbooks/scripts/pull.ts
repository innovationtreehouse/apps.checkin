// Pull Purchases since a date → normalized ground-truth JSON. Proves reads work end to end.
// Run: npm run pull -w @inventory/quickbooks -- 2024-01-01 [outfile]
import { writeFileSync } from "node:fs";
import { QuickBooksClient, toGroundTruth } from "../src/client";

const fromDate = process.argv[2] ?? "2024-01-01";
const outFile = process.argv[3] ?? new URL("../.ground-truth.json", import.meta.url).pathname;

const client = QuickBooksClient.fromSaved();
const purchases = await client.purchasesSince(fromDate);
const bills = await client.billsSince(fromDate);
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

console.log(`Pulled ${records.length} transactions (Purchases + Bills) since ${fromDate} → ${outFile}`);
console.log(`Distinct vendors: ${new Set(records.map((r) => r.vendor)).size}`);
console.log(`Totals shared by >1 txn (collision groups): ${collisions}`);
