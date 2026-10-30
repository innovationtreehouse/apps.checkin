// Mounts a receipt library call through checkin's handler(). The endpoint string MUST match
// its src/security/registry/receipt.ts entry.
import { receiptService } from "@checkin/receipt";
import { handler } from "@/security/handler";
import { receiptRoute } from "@/lib/receipt/route";

export const GET = handler(
  "GET /api/receipts/[id]/duplicate-group",
  receiptRoute<{ id: string }>(async ({ params }) => ({ ReceiptDuplicateGroup: await receiptService.duplicateGroup(params.id) })),
);
