// Mounts a receipt library call through checkin's handler(). The endpoint string MUST match
// its src/security/registry/receipt.ts entry.
import { receiptService } from "@checkin/receipt";
import { handler } from "@/security/handler";
import { receiptRoute } from "@/lib/receipt/route";

export const POST = handler(
  "POST /api/receipts/[id]/confirmation",
  receiptRoute<{ id: string }>(async ({ params }) => ({ ReceiptConfirmationView: await receiptService.confirmAsReimbursee(params.id) })),
);
