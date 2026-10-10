// Re-export stub (#1280): mounts a bulk-donation route factory under
// /api/donations/* through checkin's handler(); the stored CSV
// download goes through fileHandler(). The endpoint string MUST match
// its src/security/registry/donation.ts entry.
import { handler } from "@/security/handler";
import { fileHandler } from "@/security/fileHandler";
import { donationRoute, donationFileRoute } from "@/lib/bulkDonation/route";
import { routes } from "@inventory/bulk-donation";

export const GET = fileHandler("GET /api/donations/uploaded-files/[id]/blob", donationFileRoute(routes.uploads.download));
export const DELETE = handler("DELETE /api/donations/uploaded-files/[id]/blob", donationRoute(routes.uploads.deleteBlob));
