// Mounts a receipt library call through checkin's handler(). The endpoint string MUST match
// its src/security/registry/receipt.ts entry.
import { receiptService } from "@inventory/receipt";
import { handler } from "@/security/handler";
import { receiptRoute } from "@/lib/receipt/route";

/** The org-wide list; `?state=` narrows to one machine state. */
export const GET = handler(
  "GET /api/receipts",
  receiptRoute(async ({ req }) => {
    const state = req.nextUrl.searchParams.get("state");
    return { ReceiptView: state ? await receiptService.listByState(state) : await receiptService.listForOrg() };
  }),
);
