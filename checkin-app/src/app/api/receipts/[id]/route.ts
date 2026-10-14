// Mounts a receipt library call through checkin's handler(). The endpoint string MUST match
// its src/security/registry/receipt.ts entry.
import { receiptService } from "@inventory/receipt";
import { handler } from "@/security/handler";
import { accessOf, readJson, receiptRoute, stampLines } from "@/lib/receipt/route";

export const GET = handler(
  "GET /api/receipts/[id]",
  receiptRoute<{ id: string }>(async ({ params, role }) => {
    const receipt = await receiptService.get(params.id, accessOf(role));
    return { ReceiptView: { ...receipt, lineItems: stampLines(receipt.lineItems, receipt.uploadedByUserId) } };
  }),
);

export const PATCH = handler(
  "PATCH /api/receipts/[id]",
  receiptRoute<{ id: string }>(async (ctx) => ({
    ReceiptView: await receiptService.edit(ctx.params.id, accessOf(ctx.role), await readJson(ctx)),
  })),
);
