// The endpoint strings MUST match their src/security/registry/receipt.ts entries.
import { addMailAlias, listMailAliases } from "@/lib/receipt/mailAliases";
import { readJson, sessionId } from "@/lib/receipt/route";
import { handler } from "@/security/handler";

export const GET = handler("GET /api/finance/mail-aliases", async () => ({ PersonMailAlias: await listMailAliases() }));

export const POST = handler("POST /api/finance/mail-aliases", async (ctx) => ({
  PersonMailAlias: await addMailAlias(sessionId(ctx), await readJson(ctx)),
}));
