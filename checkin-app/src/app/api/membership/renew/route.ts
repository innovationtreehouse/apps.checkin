import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { withAuth } from "@/lib/auth";
import { beginRenewalForUser, RenewalError } from "@/lib/membership/renewal";
import { apiError } from "@/lib/api-response";
import { renewalErrorResponse } from "@/lib/domainErrorResponse";

export const dynamic = "force-dynamic";

// POST /api/membership/renew — household LEAD confirms renewal; advances
// PENDING_RENEWAL (lead gate lives in beginRenewalForUser). Response ships
// only the {id, kind, status} the UI reads — never the raw process row
// (internal-tier zoho/shopify ids and stage timestamps).
export const POST = withAuth({}, async (_req, auth) => {
    if (auth.type !== "session") return apiError("Unauthorized", 401);
    try {
        const process = await beginRenewalForUser(auth.user.id);
        return NextResponse.json({ process: { id: process.id, kind: process.kind, status: process.status } });
    } catch (error) {
        if (error instanceof RenewalError) {
            return renewalErrorResponse(error);
        }
        logger.error("Renewal begin error:", error);
        return apiError("Internal Server Error", 500);
    }
});
