// Re-export stub (#1286 track 4): mounts a global-catalog route factory
// under /api/catalog/* through checkin's handler() (admission + stripper).
// The endpoint string MUST match its src/security/registry.ts entry.
import { handler } from "@/security/handler";
import { proposals } from "@inventory/global-catalog/routes";

export const GET = handler("GET /api/proposals/item-references", proposals.list);
