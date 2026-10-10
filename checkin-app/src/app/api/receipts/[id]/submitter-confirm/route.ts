// Mounts a receipt library call through checkin's handler(). The endpoint string MUST match
// its src/security/registry/receipt.ts entry.
import { receiptService } from "@inventory/receipt";
import { handler } from "@/security/handler";
import { receiptRoute } from "@/lib/receipt/route";

export const POST = handler(
  "POST /api/receipts/[id]/submitter-confirm",
  receiptRoute<{ id: string }>(async ({ params }) => ({ ReceiptView: await receiptService.submitterConfirm(params.id) })),
);
