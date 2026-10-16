// Mounts a receipt library call through checkin's handler(). The endpoint string MUST match
// its src/security/registry/receipt.ts entry.
import { mailQueueService } from "@inventory/receipt";
import { handler } from "@/security/handler";
import { mailItemId, readJson, receiptRoute } from "@/lib/receipt/route";

export const POST = handler(
  "POST /api/receipts/mail-items/[id]/assign",
  receiptRoute<{ id: string }>(async (ctx) => ({
    ReceiptMailItem: await mailQueueService.assign(mailItemId(ctx.params.id), await readJson(ctx)),
  })),
);
