import { handler, badRequest, unauthorized } from "@/security/handler";
import { setBooksMapAccount } from "@/lib/finance/booksMap";

export const PUT = handler<{ role: string }>("PUT /api/books-map/accounts/[role]", async ({ req, auth, params }) => {
    if (auth.type !== "session") throw unauthorized();
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") throw badRequest("Invalid JSON");
    return { BooksMapAccount: await setBooksMapAccount(auth.user.id, params.role, body) };
});
