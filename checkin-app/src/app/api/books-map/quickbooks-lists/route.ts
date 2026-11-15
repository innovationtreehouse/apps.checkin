import { handler } from "@/security/handler";
import { quickBooksListsStatus } from "@/lib/finance/quickBooksLists";

export const dynamic = "force-dynamic";

export const GET = handler("GET /api/books-map/quickbooks-lists", async () => ({
    QuickBooksListsStatus: await quickBooksListsStatus(),
}));
