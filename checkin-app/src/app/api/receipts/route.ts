// Mounts a receipt library call through checkin's handler(). The endpoint string MUST match
// its src/security/registry/receipt.ts entry.
import { parseListFilter, receiptService } from "@checkin/receipt";
import { handler } from "@/security/handler";
import { receiptRoute } from "@/lib/receipt/route";

/** The org-wide list; `?state=` narrows to one machine state, `?pushed=0|1` to whether it reached receiving. */
export const GET = handler(
  "GET /api/receipts",
  receiptRoute(async ({ req }) => ({ ReceiptView: await receiptService.list(parseListFilter(req.nextUrl.searchParams)) })),
);
