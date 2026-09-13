// Re-export stub (#1286 track 4): mounts a global-catalog route factory
// under /api/catalog/* through checkin's handler() (admission + stripper).
// The endpoint string MUST match its src/security/registry.ts entry.
import { handler } from "@/security/handler";
import { items } from "@inventory/global-catalog/routes";

export const GET = handler("GET /api/catalog/items/[gtin13]", items.get);
export const PUT = handler("PUT /api/catalog/items/[gtin13]", items.update);
