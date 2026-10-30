// Re-export stub (#2182): mounts a bulk-donation route factory under
// /api/donations/* through checkin's handler(). The endpoint string MUST match
// its src/security/registry/donation.ts entry.
import { handler } from "@/security/handler";
import { componentRoute } from "@/lib/components/route";
import { routes } from "@checkin/bulk-donation";

export const POST = handler("POST /api/donations/in-kind/receipt/[id]/qb-resolve", componentRoute(routes.inKind.qbResolve("receipt")));
