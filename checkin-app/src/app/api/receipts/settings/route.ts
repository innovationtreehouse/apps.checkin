// Mounts a receipt library call through checkin's handler(). The endpoint string MUST match
// its src/security/registry/receipt.ts entry.
import { orgSettingsService } from "@inventory/receipt";
import { handler } from "@/security/handler";
import { readJson, receiptRoute } from "@/lib/receipt/route";

export const GET = handler(
  "GET /api/receipts/settings",
  receiptRoute(async () => ({ ReceiptOrgSettings: await orgSettingsService.get() })),
);

export const PUT = handler(
  "PUT /api/receipts/settings",
  receiptRoute(async (ctx) => ({ ReceiptOrgSettings: await orgSettingsService.update(await readJson(ctx)) })),
);
