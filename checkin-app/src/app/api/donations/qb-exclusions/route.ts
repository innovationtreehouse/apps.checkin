// Re-export stub (#1280): mounts a bulk-donation route factory under
// /api/donations/* through checkin's handler(). The endpoint string MUST match
// its src/security/registry/donation.ts entry.
import { handler } from "@/security/handler";
import { componentRoute } from "@/lib/components/route";
import { routes } from "@checkin/bulk-donation";

export const GET = handler("GET /api/donations/qb-exclusions", componentRoute(routes.disbursements.listExclusions));
export const POST = handler("POST /api/donations/qb-exclusions", componentRoute(routes.disbursements.createExclusion));
