// Mounts a receipt library call through checkin's handler(). The endpoint string MUST match
// its src/security/registry/receipt.ts entry.
import { receiptService } from "@checkin/receipt";
import { handler } from "@/security/handler";
import { receiptRoute } from "@/lib/receipt/route";

/** How many of the org's receipts each review queue holds, for the review screen's tabs. */
export const GET = handler(
  "GET /api/receipts/queue-counts",
  receiptRoute(async () => ({ ReceiptQueueCounts: await receiptService.queueCounts() })),
);
