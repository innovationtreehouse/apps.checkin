// Mounts a receipt library call through checkin's handler(). The endpoint string MUST match
// its src/security/registry/receipt.ts entry.
import { importReceipts } from "@inventory/receipt";
import { handler } from "@/security/handler";
import { readJson, receiptRoute } from "@/lib/receipt/route";

/** Historical bulk import: one result row per receipt; a re-run skips rows already loaded. */
export const POST = handler(
  "POST /api/receipts/import",
  receiptRoute(async (ctx) => ({ ReceiptImportResult: (await importReceipts(await readJson(ctx))).results })),
);
