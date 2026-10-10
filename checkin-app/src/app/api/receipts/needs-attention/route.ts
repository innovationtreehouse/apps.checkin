// Mounts a receipt library call through checkin's handler(). The endpoint string MUST match
// its src/security/registry/receipt.ts entry.
import { receiptService } from "@inventory/receipt";
import { handler } from "@/security/handler";
import { accessOf, receiptRoute } from "@/lib/receipt/route";

export const GET = handler(
  "GET /api/receipts/needs-attention",
  receiptRoute(async ({ role }) => ({ ReceiptView: await receiptService.listNeedsAttention(accessOf(role)) })),
);
