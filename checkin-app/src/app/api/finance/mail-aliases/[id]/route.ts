// The endpoint string MUST match its src/security/registry/receipt.ts entry.
import { aliasId, removeMailAlias } from "@/lib/receipt/mailAliases";
import { sessionId } from "@/lib/receipt/route";
import { handler } from "@/security/handler";

export const DELETE = handler<{ id: string }>("DELETE /api/finance/mail-aliases/[id]", async (ctx) => ({
  PersonMailAlias: await removeMailAlias(sessionId(ctx), aliasId(ctx.params.id)),
}));
