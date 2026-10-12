// Re-export stub (#1280): mounts a bulk-donation route factory under
// /api/donations/* through checkin's handler(). The endpoint string MUST match
// its src/security/registry/donation.ts entry.
import { handler } from "@/security/handler";
import { donationRoute } from "@/lib/bulkDonation/route";
import { routes } from "@inventory/bulk-donation";

export const GET = handler("GET /api/donations/disbursement-events", donationRoute(routes.disbursements.listEvents));
