// Mounts a receipt library call through checkin's handler(). The endpoint string MUST match
// its src/security/registry/receipt.ts entry.
import { receiptService } from "@inventory/receipt";
import { handler } from "@/security/handler";
import { readJson, receiptRoute } from "@/lib/receipt/route";

export const PUT = handler(
  "PUT /api/receipts/[id]/in-kind",
  receiptRoute<{ id: string }>(async (ctx) => ({ ReceiptView: await receiptService.setInKind(ctx.params.id, await readJson(ctx)) })),
);
