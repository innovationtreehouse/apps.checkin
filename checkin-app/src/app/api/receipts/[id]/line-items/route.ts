// Mounts a receipt library call through checkin's handler(). The endpoint string MUST match
// its src/security/registry/receipt.ts entry.
import { receiptService } from "@inventory/receipt";
import { handler } from "@/security/handler";
import { accessOf, ownLine, readJson, receiptRoute } from "@/lib/receipt/route";

export const POST = handler(
  "POST /api/receipts/[id]/line-items",
  receiptRoute<{ id: string }>(async (ctx) => ({
    ReceiptLineView: ownLine(ctx, await receiptService.addLine(ctx.params.id, accessOf(ctx.role), await readJson(ctx))),
  })),
);
