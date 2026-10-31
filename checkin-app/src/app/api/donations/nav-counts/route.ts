// Re-export stub: mounts a bulk-donation route factory under
// /api/donations/* through checkin's handler(). The endpoint string MUST match
// its src/security/registry/donation.ts entry.
import { handler } from "@/security/handler";
import { componentRoute } from "@/lib/components/route";
import { routes } from "@checkin/bulk-donation";

export const GET = handler("GET /api/donations/nav-counts", componentRoute(routes.disbursements.navCounts));
