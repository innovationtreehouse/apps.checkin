// Mounts a receipt library call through checkin's handler(). The endpoint string MUST match
// its src/security/registry/receipt.ts entry.
import { receiptService } from "@inventory/receipt";
import { handler } from "@/security/handler";
import { receiptRoute } from "@/lib/receipt/route";

/** "My receipts". `?hideCompleted=1` drops complete ones; an owed, unpaid receipt always stays. */
export const GET = handler(
  "GET /api/receipts/mine",
  receiptRoute(async ({ req }) => {
    const hideCompleted = ["1", "true"].includes(req.nextUrl.searchParams.get("hideCompleted") ?? "");
    return { ReceiptView: await receiptService.listMine({ hideCompleted }) };
  }),
);
