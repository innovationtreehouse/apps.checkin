// Mounts a receipt library call through checkin's handler(). The endpoint string MUST match
// its src/security/registry/receipt.ts entry.
import { receiptService } from "@checkin/receipt";
import { handler } from "@/security/handler";
import { receiptRoute } from "@/lib/receipt/route";

export const POST = handler(
  "POST /api/receipts/[id]/confirmation",
  receiptRoute<{ id: string }>(async ({ req, params }) => {
    const body: unknown = await req.json().catch(() => ({}));
    const reason = typeof body === "object" && body !== null && "reason" in body && typeof body.reason === "string" ? body.reason : null;
    return { ReceiptConfirmationView: await receiptService.confirmAsReimbursee(params.id, reason) };
  }),
);
