// Re-export stub: mounts a local-inventory route factory under
// /api/inventory/* through checkin's handler(). The endpoint string MUST match
// its src/security/registry/inventory.ts entry.
import { handler } from "@/security/handler";
import { componentRoute } from "@/lib/components/route";
import { routes } from "@checkin/local-inventory";

export const GET = handler("GET /api/inventory/receive-queue", componentRoute(routes.receiveQueue.list));
