// The endpoint string MUST match its src/security/registry/receipt.ts entry.
import { aliasId, approveMailAlias } from "@/lib/receipt/mailAliases";
import { sessionId } from "@/lib/receipt/route";
import { handler } from "@/security/handler";

// A moved alias keeps its approval through a merge; see approveMailAlias.
export const POST = handler<{ id: string }>("POST /api/finance/mail-aliases/[id]/approve", async (ctx) => ({
  PersonMailAlias: await approveMailAlias(sessionId(ctx), aliasId(ctx.params.id)),
}));
