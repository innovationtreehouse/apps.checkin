// Mounts a receipt library call through checkin's handler(). The endpoint string MUST match
// its src/security/registry/receipt.ts entry.
import { z } from "zod";
import { receiptService } from "@inventory/receipt";
import { badRequest, handler } from "@/security/handler";
import { readJson, receiptRoute } from "@/lib/receipt/route";

const Body = z.object({ reason: z.string().max(2000).nullable().optional() }).strict();

export const POST = handler(
  "POST /api/receipts/[id]/reject",
  receiptRoute<{ id: string }>(async (ctx) => {
    const body = Body.safeParse(await readJson(ctx));
    if (!body.success) throw badRequest("reason must be a string");
    return { ReceiptView: await receiptService.rejectFinancial(ctx.params.id, body.data.reason) };
  }),
);
