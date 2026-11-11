import { handler } from "@/security/handler";
import { listQuickBooksAccounts } from "@/lib/finance/booksMap";

export const dynamic = "force-dynamic";

export const GET = handler("GET /api/books-map/quickbooks-accounts", async () => ({
    QuickBooksAccountOption: await listQuickBooksAccounts(),
}));
