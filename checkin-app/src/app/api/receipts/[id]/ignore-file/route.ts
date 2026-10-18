// Mounts a receipt library call through checkin's handler(). The endpoint string MUST match
// its src/security/registry/receipt.ts entry.
import { mailQueueService } from "@checkin/receipt";
import { handler } from "@/security/handler";
import { readJson, receiptRoute } from "@/lib/receipt/route";

export const POST = handler(
  "POST /api/receipts/[id]/ignore-file",
  receiptRoute<{ id: string }>(async (ctx) => ({
    ReceiptIgnoredFileView: await mailQueueService.ignoreReceiptFile(ctx.params.id, await readJson(ctx)),
  })),
);
