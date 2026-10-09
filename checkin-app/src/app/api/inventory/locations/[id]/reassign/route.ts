// Re-export stub (#1287): mounts a local-inventory route factory under
// /api/inventory/* through checkin's handler(). The endpoint string MUST match
// its src/security/registry/inventory.ts entry.
import { handler } from "@/security/handler";
import { inventoryRoute } from "@/lib/localInventory/route";
import { routes } from "@inventory/local-inventory";

export const POST = handler("POST /api/inventory/locations/[id]/reassign", inventoryRoute(routes.locations.reassign));
