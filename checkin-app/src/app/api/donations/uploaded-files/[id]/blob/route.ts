// Re-export stub: mounts a bulk-donation route factory under
// /api/donations/* through checkin's handler(); the stored CSV
// download goes through fileHandler(). The endpoint string MUST match
// its src/security/registry/donation.ts entry.
import { handler } from "@/security/handler";
import { fileHandler } from "@/security/fileHandler";
import { componentRoute } from "@/lib/components/route";
import { routes } from "@checkin/bulk-donation";

export const GET = fileHandler("GET /api/donations/uploaded-files/[id]/blob", componentRoute(routes.uploads.download));
export const DELETE = handler("DELETE /api/donations/uploaded-files/[id]/blob", componentRoute(routes.uploads.deleteBlob));
