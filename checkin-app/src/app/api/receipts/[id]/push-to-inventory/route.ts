// Mounts a receipt library call through checkin's handler(). The endpoint string MUST match
// its src/security/registry/receipt.ts entry.
import { receiptService } from "@inventory/receipt";
import { handler } from "@/security/handler";
import { receiptRoute } from "@/lib/receipt/route";

/** Manual S1 re-send of one finalized receipt. Until X6 is bound it answers `pushed: false`. */
export const POST = handler(
  "POST /api/receipts/[id]/push-to-inventory",
  receiptRoute<{ id: string }>(async ({ params }) => ({ ReceiptPushResult: await receiptService.push(params.id) })),
);
