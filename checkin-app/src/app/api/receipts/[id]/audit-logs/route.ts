// Mounts a receipt library call through checkin's handler(). The endpoint string MUST match
// its src/security/registry/receipt.ts entry.
import { receiptService } from "@inventory/receipt";
import { handler } from "@/security/handler";
import { receiptRoute } from "@/lib/receipt/route";

export const GET = handler(
  "GET /api/receipts/[id]/audit-logs",
  receiptRoute<{ id: string }>(async ({ params }) => ({ ReceiptAuditLog: await receiptService.listAuditLogs(params.id) })),
);
