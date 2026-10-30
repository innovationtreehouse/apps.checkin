// Mounts a receipt library call through checkin's handler(). The endpoint string MUST match
// its src/security/registry/receipt.ts entry.
import { receiptService } from "@checkin/receipt";
import { handler } from "@/security/handler";
import { receiptRoute } from "@/lib/receipt/route";

/** The uploader acknowledges finance's rejection of their receipt, which leaves their My receipts pill. */
export const POST = handler(
  "POST /api/receipts/[id]/acknowledge-rejection",
  receiptRoute<{ id: string }>(async ({ params }) => ({ ReceiptView: await receiptService.acknowledgeRejection(params.id) })),
);
