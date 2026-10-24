// Re-export stub (#1286 track 4): mounts a global-catalog route factory
// under /api/catalog/* through checkin's handler() (admission + stripper).
// The endpoint string MUST match its src/security/registry.ts entry.
import { handler } from "@/security/handler";
import { componentRoute } from "@/lib/components/route";
import { routes } from "@checkin/global-catalog";

export const GET = handler("GET /api/catalog/items/[gtin13]", componentRoute(routes.items.get));
export const PUT = handler("PUT /api/catalog/items/[gtin13]", componentRoute(routes.items.update));
