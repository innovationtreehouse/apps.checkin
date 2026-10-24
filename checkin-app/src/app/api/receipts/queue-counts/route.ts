// Mounts a receipt library call through checkin's handler(). The endpoint string MUST match
// its src/security/registry/receipt.ts entry.
import { receiptService } from "@checkin/receipt";
import { handler } from "@/security/handler";
import { receiptRoute, sessionId } from "@/lib/receipt/route";

/**
 * How many of the org's receipts each review queue holds, for the review screen's tabs. FINANCE's
 * own queues leave out receipts the FINANCE caller is conflicted on; BOARD, which only reads, gets
 * org-wide counts.
 */
export const GET = handler(
  "GET /api/receipts/queue-counts",
  receiptRoute(async (ctx) => ({
    ReceiptQueueCounts: await receiptService.queueCounts(ctx.role === "isFinance" ? sessionId(ctx) : null),
  })),
);
