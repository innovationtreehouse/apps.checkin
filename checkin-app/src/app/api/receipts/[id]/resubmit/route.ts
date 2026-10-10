// Mounts a receipt library call through checkin's handler(). The endpoint string MUST match
// its src/security/registry/receipt.ts entry.
import { receiptService } from "@inventory/receipt";
import { handler } from "@/security/handler";
import { accessOf, receiptRoute } from "@/lib/receipt/route";

export const POST = handler(
  "POST /api/receipts/[id]/resubmit",
  receiptRoute<{ id: string }>(async ({ params, role }) => ({ ReceiptView: await receiptService.resubmit(params.id, accessOf(role)) })),
);
