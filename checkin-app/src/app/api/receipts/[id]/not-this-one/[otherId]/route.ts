// Mounts a receipt library call through checkin's handler(). The endpoint string MUST match
// its src/security/registry/receipt.ts entry.
import { receiptService } from "@checkin/receipt";
import { handler } from "@/security/handler";
import { receiptRoute } from "@/lib/receipt/route";

export const DELETE = handler(
  "DELETE /api/receipts/[id]/not-this-one/[otherId]",
  receiptRoute<{ id: string; otherId: string }>(async ({ params }) => ({
    ReceiptDuplicateGroup: await receiptService.undoNotThisOne(params.id, params.otherId),
  })),
);
