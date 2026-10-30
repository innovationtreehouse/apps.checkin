// Mounts a receipt route factory through checkin's handler(). The endpoint string MUST match
// its src/security/registry/receipt.ts entry.
import { receiptService, routes } from "@checkin/receipt";
import { handler } from "@/security/handler";
import { accessOf, receiptHostRoute, receiptRoute, stampLines } from "@/lib/receipt/route";

export const GET = handler(
  "GET /api/receipts/[id]",
  receiptHostRoute<{ id: string }>(async ({ params, role }) => {
    const receipt = await receiptService.get(params.id, accessOf(role));
    return { ReceiptView: { ...receipt, lineItems: stampLines(receipt.lineItems, receipt.uploadedByUserId) } };
  }),
);

export const PATCH = handler("PATCH /api/receipts/[id]", receiptRoute(routes.receipts.edit));
