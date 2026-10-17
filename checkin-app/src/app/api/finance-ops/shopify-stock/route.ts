import { handler } from "@/security/handler";
import { listUnconfirmedStock } from "@/lib/shopify";

/** GET /api/finance-ops/shopify-stock — every program with an unconfirmed Shopify stock change (Board only). */
export const GET = handler("GET /api/finance-ops/shopify-stock", async () => ({
    UnconfirmedStockRow: await listUnconfirmedStock(),
}));
