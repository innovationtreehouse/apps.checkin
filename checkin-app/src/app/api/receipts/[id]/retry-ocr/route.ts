// Mounts a receipt library call through checkin's handler(). The endpoint string MUST match
// its src/security/registry/receipt.ts entry.
import { receiptService } from "@inventory/receipt";
import { handler } from "@/security/handler";
import { accessOf, receiptRoute, sessionId, spendOcrQuota } from "@/lib/receipt/route";

export const POST = handler(
  "POST /api/receipts/[id]/retry-ocr",
  receiptRoute<{ id: string }>(async (ctx) => {
    spendOcrQuota(sessionId(ctx));
    return { ReceiptView: await receiptService.retryOcr(ctx.params.id, accessOf(ctx.role)) };
  }),
);
