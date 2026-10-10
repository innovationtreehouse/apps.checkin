// Mounts a receipt library call through checkin's handler(). The endpoint string MUST match
// its src/security/registry/receipt.ts entry.
import { importReceipts } from "@inventory/receipt";
import { handler } from "@/security/handler";
import { MAX_IMPORT_BODY_BYTES, readJsonCapped, receiptRoute } from "@/lib/receipt/route";

/** Historical bulk import: one result row per receipt; a re-run skips rows already loaded. */
export const POST = handler(
  "POST /api/receipts/import",
  receiptRoute(async ({ req }) => {
    const batch = await readJsonCapped(
      req.body,
      req.headers.get("content-length"),
      MAX_IMPORT_BODY_BYTES,
      "Import batch exceeds 50 MB; split it into smaller batches",
    );
    return { ReceiptImportResult: (await importReceipts(batch)).results };
  }),
);
