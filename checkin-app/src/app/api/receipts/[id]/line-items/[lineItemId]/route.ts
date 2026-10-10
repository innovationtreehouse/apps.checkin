// Mounts a receipt library call through checkin's handler(). The endpoint string MUST match
// its src/security/registry/receipt.ts entry.
import { receiptService } from "@inventory/receipt";
import { handler } from "@/security/handler";
import { accessOf, lineItemId, ownLine, readJson, receiptRoute } from "@/lib/receipt/route";

export const PATCH = handler(
  "PATCH /api/receipts/[id]/line-items/[lineItemId]",
  receiptRoute<{ id: string; lineItemId: string }>(async (ctx) => {
    const line = await receiptService.editLine(ctx.params.id, accessOf(ctx.role), lineItemId(ctx.params.lineItemId), await readJson(ctx));
    return { ReceiptLineView: ownLine(ctx, line) };
  }),
);

export const DELETE = handler(
  "DELETE /api/receipts/[id]/line-items/[lineItemId]",
  receiptRoute<{ id: string; lineItemId: string }>(async ({ params, role }) => {
    await receiptService.deleteLine(params.id, accessOf(role), lineItemId(params.lineItemId));
    return {};
  }),
);
