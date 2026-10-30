// Mounts a receipt route factory through checkin's handler(). The endpoint string MUST match
// its src/security/registry/receipt.ts entry.
import { receiptService } from "@checkin/receipt";
import { handler } from "@/security/handler";
import { accessOf, ownLine, readJson, receiptHostRoute } from "@/lib/receipt/route";

export const POST = handler(
  "POST /api/receipts/[id]/line-items",
  receiptHostRoute<{ id: string }>(async (ctx) => ({
    ReceiptLineView: ownLine(ctx, await receiptService.addLine(ctx.params.id, accessOf(ctx.role), await readJson(ctx))),
  })),
);
