import { handler, badRequest, unauthorized } from "@/security/handler";
import { setBooksMapClass } from "@/lib/finance/booksMap";

export const PUT = handler<{ budgetOwnerId: string }>("PUT /api/books-map/classes/[budgetOwnerId]", async ({ req, auth, params }) => {
    if (auth.type !== "session") throw unauthorized();
    const id = Number(params.budgetOwnerId);
    if (!Number.isInteger(id)) throw badRequest("Invalid bucket id");
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") throw badRequest("Invalid JSON");
    return { BooksMapClass: await setBooksMapClass(auth.user.id, id, body) };
});
