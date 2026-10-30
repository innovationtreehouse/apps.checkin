// Mounts a receipt library call through checkin's handler(). The endpoint string MUST match
// its src/security/registry/receipt.ts entry.
import { receiptService } from "@checkin/receipt";
import { handler } from "@/security/handler";
import { receiptRoute } from "@/lib/receipt/route";

/** People matching `?q=`, for naming who is reimbursed on upload. */
export const GET = handler(
  "GET /api/receipts/reimbursee-options",
  receiptRoute(async ({ req }) => ({
    ReceiptReimburseeOption: await receiptService.reimburseeOptions(req.nextUrl.searchParams.get("q")),
  })),
);
