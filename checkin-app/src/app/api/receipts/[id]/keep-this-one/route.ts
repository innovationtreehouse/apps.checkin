// Mounts a receipt library call through checkin's handler(). The endpoint string MUST match
// its src/security/registry/receipt.ts entry.
import { z } from "zod";
import { receiptService } from "@checkin/receipt";
import { badRequest, handler } from "@/security/handler";
import { readJson, receiptRoute } from "@/lib/receipt/route";

const Body = z.object({ shownIds: z.array(z.string().min(1)).min(1).max(100) }).strict();

export const POST = handler(
  "POST /api/receipts/[id]/keep-this-one",
  receiptRoute<{ id: string }>(async (ctx) => {
    const body = Body.safeParse(await readJson(ctx));
    if (!body.success) throw badRequest("Send the ids of the receipts the panel showed");
    return { ReceiptView: await receiptService.keepThisOne(ctx.params.id, body.data.shownIds) };
  }),
);
