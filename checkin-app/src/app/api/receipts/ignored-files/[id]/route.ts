// Mounts a receipt library call through checkin's handler(). The endpoint string MUST match
// its src/security/registry/receipt.ts entry.
import { mailQueueService } from "@checkin/receipt";
import { handler } from "@/security/handler";
import { ignoredFileId, receiptRoute } from "@/lib/receipt/route";

export const DELETE = handler(
  "DELETE /api/receipts/ignored-files/[id]",
  receiptRoute<{ id: string }>(async (ctx) => ({
    ReceiptIgnoredFileView: await mailQueueService.removeIgnored(ignoredFileId(ctx.params.id)),
  })),
);
