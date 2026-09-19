import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { withAuth } from "@/lib/auth";
import { apiError } from "@/lib/api-response";
import { getKioskCertifications } from "@/lib/getKioskCertifications";

// Serves the participant roster for the tool-certification grid: id, a display name, the
// nickname that stands in for the first name, and tool certs. The raw email is read only to resolve the name fallback and never leaves the
// DB (#329). Same data class as /api/attendance, so the same gate: a valid kiosk signature, or
// a privileged session (isSysadmin/isBoardMember/isKeyholder). A plain member session gets
// 403 — withAuth handles the kiosk path, role check, denied-household, and local dev.
export const GET = withAuth(
    { roles: ["isSysadmin", "isBoardMember", "isKeyholder"], allowKiosk: true },
    async (req: NextRequest) => {
    try {
        const url = new URL(req.url);
        const limitToPresent = url.searchParams.get("limit_to_present") !== "false";
        const { participants, tools } = await getKioskCertifications({ limitToPresent });
        return NextResponse.json({ participants, tools });
    } catch (error) {
        logger.error("Certifications fetch error:", error);
        return apiError("Internal Server Error while fetching certifications.", 500);
    }
});
