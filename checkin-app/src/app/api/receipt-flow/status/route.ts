// The receipt flow status page's counts through checkin's handler(). The endpoint string MUST match
// its src/security/registry/receipt.ts entry.
import { handler, type HandlerContext } from "@/security/handler";
import { componentRoute } from "@/lib/components/route";
import { receiptFlowStatus } from "@/lib/receiptFlow/status";

export const GET = handler(
  "GET /api/receipt-flow/status",
  componentRoute(async ({ role }: HandlerContext) => ({ ReceiptFlowStatus: await receiptFlowStatus(role) })),
);
