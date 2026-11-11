// Mounts a receipt route factory through checkin's handler(). The endpoint string MUST match
// its src/security/registry/receipt.ts entry.
import { routes } from "@checkin/receipt";
import { handler } from "@/security/handler";
import { receiptRoute } from "@/lib/receipt/route";

export const GET = handler("GET /api/receipts/settings", receiptRoute(routes.receipts.getSettings));
export const PUT = handler("PUT /api/receipts/settings", receiptRoute(routes.receipts.updateSettings));
