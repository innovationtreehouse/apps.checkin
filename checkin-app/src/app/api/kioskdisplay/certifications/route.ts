import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { withAuth } from "@/lib/auth";
import { apiError } from "@/lib/api-response";
import { getKioskCertifications } from "@/lib/getKioskCertifications";
import { buildingLink } from "@/lib/kioskSeen";
import { CERTIFICATION_GRID_ROLES } from "@/lib/nav/sections/personal";

// Serves the participant roster for the tool-certification grid: id, the kiosk label
// (getKioskDisplayNames — never a whole last name, never an address), and tool certs. Same data class
// as /api/attendance, so the same gate: a valid kiosk signature, or a privileged session (CERTIFICATION_GRID_ROLES). A plain member session gets
// 403 — withAuth handles the kiosk path, role check, denied-household, and local dev.
export const GET = withAuth(
    { roles: [...CERTIFICATION_GRID_ROLES], allowKiosk: true },
    async (req: NextRequest) => {
    try {
        const url = new URL(req.url);
        const limitToPresent = url.searchParams.get("limit_to_present") !== "false";
        const { participants, tools } = await getKioskCertifications({ limitToPresent });
        return NextResponse.json({ participants, tools, building: buildingLink() });
    } catch (error) {
        logger.error("Certifications fetch error:", error);
        return apiError("Internal Server Error while fetching certifications.", 500);
    }
});
