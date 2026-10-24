// Mounts a receipt library call through checkin's handler(). The endpoint string MUST match
// its src/security/registry/receipt.ts entry.
import { mailQueueService } from "@checkin/receipt";
import { handler } from "@/security/handler";
import { receiptRoute } from "@/lib/receipt/route";

export const GET = handler(
  "GET /api/receipts/ignored-files",
  receiptRoute(async () => ({ ReceiptIgnoredFileView: await mailQueueService.listIgnored() })),
);
