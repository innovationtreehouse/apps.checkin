// Mounts a receipt library call through checkin's handler(). The endpoint string MUST match
// its src/security/registry/receipt.ts entry.
import { receiptService } from "@checkin/receipt";
import { handler } from "@/security/handler";
import { receiptRoute } from "@/lib/receipt/route";

/** Reimbursements naming the caller that someone else uploaded, with what became of each. */
export const GET = handler(
  "GET /api/receipts/reimbursements",
  receiptRoute(async () => ({ ReceiptReimbursedView: await receiptService.listReimbursedToMe() })),
);
