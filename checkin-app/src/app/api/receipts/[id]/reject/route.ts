// Mounts a receipt library call through checkin's handler(). The endpoint string MUST match
// its src/security/registry/receipt.ts entry.
import { z } from "zod";
import { receiptService } from "@checkin/receipt";
import { badRequest, handler } from "@/security/handler";
import { readJson, receiptRoute } from "@/lib/receipt/route";

const Body = z.object({ reason: z.string().trim().min(1).max(2000) }).strict();

export const POST = handler(
  "POST /api/receipts/[id]/reject",
  receiptRoute<{ id: string }>(async (ctx) => {
    const body = Body.safeParse(await readJson(ctx));
    if (!body.success) throw badRequest("A reason of up to 2000 characters is required to reject a receipt");
    return { ReceiptView: await receiptService.rejectFinancial(ctx.params.id, body.data.reason) };
  }),
);
