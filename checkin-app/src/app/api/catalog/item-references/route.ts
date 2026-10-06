// Re-export stub (#1286 track 4): mounts a global-catalog route factory
// under /api/catalog/* through checkin's handler() (admission + stripper).
// The endpoint string MUST match its src/security/registry.ts entry.
import { handler } from "@/security/handler";
import { catalogRoute } from "@/lib/catalog/route";
import { routes } from "@inventory/global-catalog";

export const GET = handler("GET /api/catalog/item-references", catalogRoute(routes.itemReferences.list));
export const POST = handler("POST /api/catalog/item-references", catalogRoute(routes.itemReferences.create));
