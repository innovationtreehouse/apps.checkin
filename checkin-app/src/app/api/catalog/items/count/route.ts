// Re-export stub (#1286): item count for the paginated list UI. The endpoint
// string MUST match its src/security/registry.ts entry (stub-endpoint guard).
import { handler } from "@/security/handler";
import { items } from "@inventory/global-catalog/routes";

export const GET = handler("GET /api/catalog/items/count", items.count);
