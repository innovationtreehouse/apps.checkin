// The receipt flow status page's counts through checkin's handler(). The endpoint string MUST match
// its src/security/registry/receipt.ts entry.
import { ApiResponseError, handler, type HandlerContext } from "@/security/handler";
import { componentRoute } from "@/lib/components/route";
import { isReceiptFlowRole, receiptFlowStatus } from "@/lib/receiptFlow/status";

export const GET = handler(
  "GET /api/receipt-flow/status",
  componentRoute(async ({ role }: HandlerContext) => {
    if (!isReceiptFlowRole(role)) throw new ApiResponseError(403, "Forbidden");
    return { ReceiptFlowStatus: await receiptFlowStatus(role) };
  }),
);
