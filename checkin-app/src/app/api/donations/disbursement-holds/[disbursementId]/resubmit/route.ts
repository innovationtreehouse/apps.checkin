// Re-export stub (#1280): mounts a bulk-donation route factory under
// /api/donations/* through checkin's handler(). The endpoint string MUST match
// its src/security/registry/donation.ts entry.
import { handler } from "@/security/handler";
import { donationRoute } from "@/lib/bulkDonation/route";
import { routes } from "@inventory/bulk-donation";

export const POST = handler("POST /api/donations/disbursement-holds/[disbursementId]/resubmit", donationRoute(routes.disbursements.resubmitHold));
