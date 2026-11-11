// Re-export stub: mounts a global-catalog route factory
// under /api/catalog/* through checkin's handler() (admission + stripper).
// The endpoint string MUST match its src/security/registry.ts entry.
import { handler } from "@/security/handler";
import { componentRoute } from "@/lib/components/route";
import { routes } from "@checkin/global-catalog";

export const PUT = handler("PUT /api/catalog/item-references/[id]", componentRoute(routes.itemReferences.update));
