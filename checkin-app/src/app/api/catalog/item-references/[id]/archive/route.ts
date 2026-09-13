// Re-export stub (#1286 track 4): mounts a global-catalog route factory
// under /api/catalog/* through checkin's handler() (admission + stripper).
// The endpoint string MUST match its src/security/registry.ts entry.
import { handler } from "@/security/handler";
import { itemReferences } from "@inventory/global-catalog/routes";

export const POST = handler("POST /api/item-references/[id]/archive", itemReferences.archive);
