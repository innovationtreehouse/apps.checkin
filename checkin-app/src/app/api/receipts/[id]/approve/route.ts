// Mounts a receipt library call through checkin's handler(). The endpoint string MUST match
// its src/security/registry/receipt.ts entry.
import { z } from "zod";
import { receiptService } from "@inventory/receipt";
import { badRequest, handler } from "@/security/handler";
import { readJson, receiptRoute } from "@/lib/receipt/route";

const Body = z.object({ note: z.string().max(2000).nullable().optional() }).strict();

export const POST = handler(
  "POST /api/receipts/[id]/approve",
  receiptRoute<{ id: string }>(async (ctx) => {
    const body = Body.safeParse(await readJson(ctx));
    if (!body.success) throw badRequest("note must be a string");
    return { ReceiptView: await receiptService.approveFinancial(ctx.params.id, body.data.note) };
  }),
);
