// Mounts a receipt library call through checkin's handler(). The endpoint string MUST match
// its src/security/registry/receipt.ts entry.
import { receiptService } from "@checkin/receipt";
import { handler } from "@/security/handler";
import { receiptRoute } from "@/lib/receipt/route";

/** Reimbursements waiting for the caller's confirmation, as the person reimbursed or a Board member on their behalf. */
export const GET = handler(
  "GET /api/receipts/confirmations",
  receiptRoute(async () => ({ ReceiptConfirmationView: await receiptService.listConfirmations() })),
);
