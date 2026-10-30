// Mounts a receipt library call through checkin's handler(). The endpoint string MUST match
// its src/security/registry/receipt.ts entry.
import { z } from "zod";
import { receiptService } from "@checkin/receipt";
import { badRequest, handler } from "@/security/handler";
import { readJson, receiptRoute } from "@/lib/receipt/route";

const Body = z.object({ otherId: z.string().min(1) }).strict();

export const POST = handler(
  "POST /api/receipts/[id]/not-this-one",
  receiptRoute<{ id: string }>(async (ctx) => {
    const body = Body.safeParse(await readJson(ctx));
    if (!body.success) throw badRequest("Name the match that is not this one");
    return { ReceiptDuplicateGroup: await receiptService.notThisOne(ctx.params.id, body.data.otherId) };
  }),
);
