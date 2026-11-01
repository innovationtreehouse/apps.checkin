// Re-export stub: item count for the paginated list UI. The endpoint
// string MUST match its src/security/registry.ts entry (stub-endpoint guard).
import { handler } from "@/security/handler";
import { componentRoute } from "@/lib/components/route";
import { routes } from "@checkin/global-catalog";

export const GET = handler("GET /api/catalog/items/count", componentRoute(routes.items.count));
