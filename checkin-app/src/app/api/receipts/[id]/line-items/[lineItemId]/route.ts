// Mounts a receipt route factory through checkin's handler(). The endpoint string MUST match
// its src/security/registry/receipt.ts entry.
import { parseId } from "@checkin/component-kit";
import { receiptService, routes } from "@checkin/receipt";
import { handler } from "@/security/handler";
import { accessOf, ownLine, readJson, receiptHostRoute, receiptRoute } from "@/lib/receipt/route";

export const PATCH = handler(
  "PATCH /api/receipts/[id]/line-items/[lineItemId]",
  receiptHostRoute<{ id: string; lineItemId: string }>(async (ctx) => {
    const line = await receiptService.editLine(ctx.params.id, accessOf(ctx.role), parseId(ctx.params.lineItemId, "line item id"), await readJson(ctx));
    return { ReceiptLineView: ownLine(ctx, line) };
  }),
);

export const DELETE = handler("DELETE /api/receipts/[id]/line-items/[lineItemId]", receiptRoute(routes.receipts.deleteLine));
