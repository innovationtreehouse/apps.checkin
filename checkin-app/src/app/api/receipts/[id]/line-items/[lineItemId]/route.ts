// Mounts a receipt route factory through checkin's handler(). The endpoint string MUST match
// its src/security/registry/receipt.ts entry.
import { routes } from "@checkin/receipt";
import { handler } from "@/security/handler";
import { receiptRoute } from "@/lib/receipt/route";

export const PATCH = handler("PATCH /api/receipts/[id]/line-items/[lineItemId]", receiptRoute(routes.receipts.editLine));

export const DELETE = handler("DELETE /api/receipts/[id]/line-items/[lineItemId]", receiptRoute(routes.receipts.deleteLine));
