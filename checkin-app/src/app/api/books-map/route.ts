import { handler } from "@/security/handler";
import { listBooksMap } from "@/lib/finance/booksMap";

export const dynamic = "force-dynamic";

export const GET = handler("GET /api/books-map", async () => listBooksMap());
